import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import PostalMime, { type Address } from "postal-mime";
import {
  formSubmissionSchema,
  type IntakeChannel,
  intakeChannelSchema,
  type PublicForm,
  updateIntakeChannelSchema,
} from "@glasstrack/shared";
import { clientIp } from "../auth/routes";
import { type AppEnv, type Ctx, type Deps, requireRole, requireUser } from "../context";
import { layout } from "../email";
import { asWorkspace, notify, type Tx } from "../db/tenant";
import { ApiError, badRequest, notFound } from "../lib/errors";
import { newToken, uuid7 } from "../lib/ids";
import { logger } from "../lib/logger";
import { RateLimiter } from "../lib/rateLimit";
import { workspacePrefix } from "../storage";
import { audit } from "./audit";
import { assertLabels, assertState, createIssueCore, recordActivity } from "./issueService";
import { createNotifications, subscribersOf } from "./notifyService";
import { assertTeamAccess } from "./teams";
import { enqueueWebhookEvent } from "./webhooks";

/** In-process limits, like the rest of the app (single process). */
export const intakeLimits = {
  formPerIp: new RateLimiter(5, 10 * 60_000),
  perChannel: new RateLimiter(100, 60 * 60_000),
  reset() {
    this.formPerIp.reset();
    this.perChannel.reset();
  },
};

const MAX_EMAIL_BYTES = 15 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const COLS = ["id", "teamId", "kind", "token", "name", "intro", "enabled", "statusId", "labelIds", "requireEmail", "membersOnly", "notifySubmitter", "createdAt"] as const;
type Row = { id: string; teamId: string; kind: "form" | "email"; token: string; name: string; intro: string; enabled: boolean; statusId: string | null; labelIds: string[]; requireEmail: boolean; membersOnly: boolean; notifySubmitter: boolean; createdAt: Date };

function address(deps: Deps, r: { kind: "form" | "email"; token: string }): string | null {
  if (r.kind === "form") return `${deps.config.APP_URL.replace(/\/$/, "")}/forms/${r.token}`;
  return deps.config.INBOUND_EMAIL_DOMAIN && deps.config.INBOUND_EMAIL_SECRET ? `${r.token}@${deps.config.INBOUND_EMAIL_DOMAIN}` : null;
}

const toChannel = (deps: Deps, r: Row): IntakeChannel => ({
  id: r.id, teamId: r.teamId, kind: r.kind, name: r.name, intro: r.intro, enabled: r.enabled, statusId: r.statusId, labelIds: r.labelIds ?? [],
  requireEmail: r.requireEmail, membersOnly: r.membersOnly, notifySubmitter: r.notifySubmitter, address: address(deps, r), createdAt: r.createdAt.toISOString(),
});

/** Email tokens become the local part of an address, so keep them lowercase and short. */
const emailToken = () => `in-${newToken().replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 20)}`;

async function checkRefs(trx: Tx, teamId: string, statusId: string | null | undefined, labelIds: string[] | undefined) {
  if (statusId) await assertState(trx, statusId, teamId);
  if (labelIds?.length) await assertLabels(trx, labelIds, teamId);
}

// ─── settings (workspace routes) ───

export const intakeSettingsRoutes = new Hono<AppEnv>()
  .get("/intake", async (c) => {
    requireRole(c, "member");
    const rows = await c.get("trx").selectFrom("intakeChannels").select(COLS).orderBy("createdAt").execute();
    return c.json(rows.map((r) => toChannel(c.get("deps"), r)));
  })
  .post("/intake", async (c) => {
    requireRole(c, "admin");
    const user = requireUser(c);
    const body = intakeChannelSchema.parse(await c.req.json());
    await assertTeamAccess(c, body.teamId);
    const trx = c.get("trx");
    await checkRefs(trx, body.teamId, body.statusId, body.labelIds);
    const id = uuid7();
    const row = await trx.insertInto("intakeChannels").values({
      id, workspaceId: c.get("ws").id, teamId: body.teamId, kind: body.kind, token: body.kind === "email" ? emailToken() : newToken(),
      name: body.name, intro: body.intro ?? "", enabled: body.enabled ?? true, statusId: body.statusId ?? null, labelIds: body.labelIds ?? [],
      requireEmail: body.requireEmail ?? false, membersOnly: body.membersOnly ?? false, notifySubmitter: body.notifySubmitter ?? true, createdBy: user.id,
    }).returning(COLS).executeTakeFirstOrThrow();
    await audit(c, "intake.created", "intake", id, { kind: body.kind, name: body.name });
    return c.json(toChannel(c.get("deps"), row), 201);
  })
  .patch("/intake/:id", async (c) => {
    requireRole(c, "admin");
    const body = updateIntakeChannelSchema.parse(await c.req.json());
    const trx = c.get("trx");
    const cur = await trx.selectFrom("intakeChannels").select(COLS).where("id", "=", c.req.param("id")).executeTakeFirst();
    if (!cur) throw notFound("Not found");
    const teamId = body.teamId ?? cur.teamId;
    if (body.teamId) await assertTeamAccess(c, body.teamId);
    // Moving teams drops a status/labels from the old team unless new ones are given.
    const statusId = body.statusId !== undefined ? body.statusId : teamId === cur.teamId ? cur.statusId : null;
    const labelIds = body.labelIds ?? (teamId === cur.teamId ? cur.labelIds : []);
    await checkRefs(trx, teamId, statusId, labelIds);
    const { rotateToken, ...rest } = body;
    const row = await trx.updateTable("intakeChannels").set({
      ...rest, teamId, statusId, labelIds, updatedAt: new Date(),
      ...(rotateToken ? { token: cur.kind === "email" ? emailToken() : newToken() } : {}),
    }).where("id", "=", cur.id).returning(COLS).executeTakeFirstOrThrow();
    await audit(c, "intake.updated", "intake", cur.id, { name: row.name, enabled: row.enabled, rotatedToken: Boolean(rotateToken) });
    return c.json(toChannel(c.get("deps"), row));
  })
  .delete("/intake/:id", async (c) => {
    requireRole(c, "admin");
    const r = await c.get("trx").deleteFrom("intakeChannels").where("id", "=", c.req.param("id")).returning("name").executeTakeFirst();
    if (!r) throw notFound("Not found");
    await audit(c, "intake.deleted", "intake", c.req.param("id"), { name: r.name });
    return c.json({ ok: true });
  });

// ─── shared: turn a request into an issue ───

interface Channel { id: string; workspaceId: string; slug: string; teamId: string; name: string; statusId: string | null; labelIds: string[] }

async function findChannel(deps: Deps, kind: "form" | "email", token: string) {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(token)) return undefined;
  return deps.dbs.system.selectFrom("intakeChannels as ch").innerJoin("workspaces as w", "w.id", "ch.workspaceId").innerJoin("teams as t", "t.id", "ch.teamId")
    .select(["ch.id", "ch.workspaceId", "w.slug", "w.name as workspaceName", "w.status", "ch.teamId", "ch.name", "ch.intro", "ch.statusId", "ch.labelIds", "ch.requireEmail", "ch.membersOnly", "t.archivedAt"])
    .where("ch.token", "=", token).where("ch.kind", "=", kind).where("ch.enabled", "=", true).executeTakeFirst()
    .then((r) => (r && !r.archivedAt && (r.status === "active" || r.status === "grace") ? r : undefined));
}

async function createFromRequest(
  deps: Deps,
  ch: Channel,
  p: { title: string; description: string; email: string | null; name: string | null; messageId?: string | null; via: "form" | "email"; files?: { filename: string; contentType: string; body: Buffer }[] },
) {
  // Files go to storage first; a failed transaction leaves at most a few orphaned objects.
  const files = (p.files ?? []).map((f) => ({ ...f, id: uuid7() }));
  for (const f of files) {
    await deps.storage.put(`${workspacePrefix(ch.workspaceId)}attachments/${f.id}/${f.filename}`, f.body, f.contentType);
  }
  const issue = await asWorkspace(deps.dbs.app, ch.workspaceId, async (trx) => {
    const id = await createIssueCore(trx, {
      workspaceId: ch.workspaceId, actorId: null, visible: null,
      input: { teamId: ch.teamId, title: p.title, description: p.description, statusId: ch.statusId, priority: 0, assigneeIds: [], labelIds: ch.labelIds ?? [], fields: {} },
      activity: { via: p.via, channel: ch.name, from: p.email },
    });
    await trx.insertInto("intakeSubmissions").values({
      issueId: id, workspaceId: ch.workspaceId, channelId: ch.id, submitterEmail: p.email, submitterName: p.name, messageId: p.messageId ?? null,
    }).execute();
    for (const f of files) {
      await trx.insertInto("attachments").values({
        id: f.id, workspaceId: ch.workspaceId, issueId: id, uploaderId: null, storageKey: `${workspacePrefix(ch.workspaceId)}attachments/${f.id}/${f.filename}`,
        filename: f.filename, contentType: f.contentType, sizeBytes: f.body.length, uploadedAt: new Date(),
      }).execute();
    }
    return trx.selectFrom("issues as i").innerJoin("teams as t", "t.id", "i.teamId").select(["i.id", "i.number", "i.title", "t.key"]).where("i.id", "=", id).executeTakeFirstOrThrow();
  });
  await deps.jobs.send("automation.event", { workspaceId: ch.workspaceId, issueId: issue.id, actorId: "", events: [{ type: "issue_created" }] }).catch(() => undefined);
  await enqueueWebhookEvent(deps, { id: ch.workspaceId, slug: ch.slug }, "issue.created", {
    issue: { id: issue.id, identifier: `${issue.key}-${issue.number}`, title: issue.title }, source: p.via,
  });
  return issue;
}

function limited(key: string, limiter: RateLimiter, c: Ctx) {
  const wait = limiter.take(key);
  if (wait > 0) {
    c.header("Retry-After", String(wait));
    throw new ApiError(429, "rate_limited", "Too many requests. Please try again later.");
  }
}

// ─── public request forms: /api/v1/forms/:token ───

export const publicFormRoutes = new Hono<AppEnv>()
  .get("/:token", async (c) => {
    const ch = await findChannel(c.get("deps"), "form", c.req.param("token"));
    if (!ch) throw notFound("This form doesn't exist or is closed");
    return c.json({ name: ch.name, intro: ch.intro, workspaceName: ch.workspaceName, requireEmail: ch.requireEmail } satisfies PublicForm);
  })
  .post("/:token", async (c) => {
    const deps = c.get("deps");
    const ch = await findChannel(deps, "form", c.req.param("token"));
    if (!ch) throw notFound("This form doesn't exist or is closed");
    const raw = (await c.req.json()) as Record<string, unknown>;
    // Bots fill every field; pretend it worked, before any validation can give it away.
    if (raw && typeof raw === "object" && raw.website) return c.json({ ok: true }, 201);
    const body = formSubmissionSchema.parse(raw);
    if (ch.requireEmail && !body.email) throw badRequest("Please give your email address");
    limited(`ip:${clientIp(c)}`, intakeLimits.formPerIp, c);
    limited(`ch:${ch.id}`, intakeLimits.perChannel, c);
    await createFromRequest(deps, ch, { title: body.title, description: body.description, email: body.email?.toLowerCase() ?? null, name: body.name || null, via: "form" });
    return c.json({ ok: true }, 201);
  });

// ─── inbound email: POST /api/v1/inbound/email?to=<envelope recipient> ───

const firstMailbox = (a: Address | undefined) => (a ? (a.address ? a : a.group?.[0]) : undefined);

/** Very small HTML-to-text for emails without a text part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Drops the quoted earlier message from a reply ("On ... wrote:" and "> " lines). */
export function stripQuotedReply(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .+wrote:\s*$/.test(line) || /^-{2,}\s*Original Message\s*-{2,}/i.test(line) || /^_{5,}$/.test(line)) break;
    if (line.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

const safeName = (s: string) => s.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";

export const inboundEmailRoutes = new Hono<AppEnv>().post("/email", async (c) => {
  const deps = c.get("deps");
  const secret = deps.config.INBOUND_EMAIL_SECRET;
  // Its own header: "Authorization: Bearer" is reserved for API tokens.
  const auth = c.req.header("x-glasstrack-inbound-secret") ?? "";
  const want = Buffer.from(secret);
  if (!secret || auth.length !== want.length || !timingSafeEqual(Buffer.from(auth), want)) throw new ApiError(401, "unauthorized", "Bad inbound email secret");
  const raw = Buffer.from(await c.req.arrayBuffer());
  if (raw.length > MAX_EMAIL_BYTES) throw new ApiError(413, "too_large", "Email is too large");
  const mail = await PostalMime.parse(raw);

  // The envelope recipient from the forwarder wins; otherwise look through To/Cc.
  const domain = deps.config.INBOUND_EMAIL_DOMAIN.toLowerCase();
  const candidates = [c.req.query("to"), ...(mail.to ?? []).map((a) => firstMailbox(a)?.address), ...(mail.cc ?? []).map((a) => firstMailbox(a)?.address), mail.deliveredTo]
    .filter((x): x is string => Boolean(x)).map((x) => x.toLowerCase());
  const token = candidates.map((a) => a.split("@")).find(([, d]) => !domain || d === domain)?.[0]?.split("+")[0];
  const ch = token ? await findChannel(deps, "email", token) : undefined;
  if (!ch) throw notFound("Unknown inbox");

  // Never answer or loop on automatic mail.
  const header = (k: string) => mail.headers.find((h) => h.key === k)?.value?.toLowerCase() ?? "";
  const from = firstMailbox(mail.from);
  const fromAddress = from?.address?.toLowerCase() ?? null;
  if ((header("auto-submitted") && header("auto-submitted") !== "no") || /bulk|junk|list/.test(header("precedence")) || !fromAddress || /^(mailer-daemon|postmaster)@/.test(fromAddress)) {
    return c.json({ ok: true, ignored: "automatic" });
  }
  if (ch.membersOnly) {
    const member = await deps.dbs.system.selectFrom("workspaceMembers as m").innerJoin("users as u", "u.id", "m.userId").select("m.userId")
      .where("m.workspaceId", "=", ch.workspaceId).where(({ fn }) => fn("lower", ["u.email"]), "=", fromAddress).executeTakeFirst();
    if (!member) return c.json({ ok: true, ignored: "not_a_member" });
  }
  limited(`ch:${ch.id}`, intakeLimits.perChannel, c);

  const text = (mail.text?.trim() || htmlToText(mail.html ?? "")).slice(0, 20_000);
  // A reply to an earlier request becomes a comment on that issue.
  const refs = [mail.inReplyTo, ...(mail.references ?? "").split(/\s+/)].filter((x): x is string => Boolean(x));
  if (refs.length) {
    const prior = await deps.dbs.system.selectFrom("intakeSubmissions").select("issueId")
      .where("workspaceId", "=", ch.workspaceId).where("messageId", "in", refs).executeTakeFirst();
    if (prior) {
      const body = `${stripQuotedReply(text).slice(0, 10_000) || "(empty reply)"}\n\n_Email from ${fromAddress}_`;
      await asWorkspace(deps.dbs.app, ch.workspaceId, async (trx) => {
        const id = uuid7();
        await trx.insertInto("comments").values({ id, workspaceId: ch.workspaceId, issueId: prior.issueId, authorId: null, bodyMd: body }).execute();
        await recordActivity(trx, ch.workspaceId, prior.issueId, null, "email_reply", { from: fromAddress });
        await createNotifications(trx, {
          workspaceId: ch.workspaceId, issueId: prior.issueId, actorId: null, kind: "commented",
          userIds: await subscribersOf(trx, prior.issueId), data: { commentId: id, excerpt: body.slice(0, 200), via: "email", from: fromAddress },
        });
        await trx.updateTable("issues").set({ updatedAt: new Date() }).where("id", "=", prior.issueId).execute();
        await notify(trx, ch.workspaceId, { t: "comment", id, issueId: prior.issueId });
      });
      await deps.jobs.send("automation.event", { workspaceId: ch.workspaceId, issueId: prior.issueId, actorId: "", events: [{ type: "comment_added" }] }).catch(() => undefined);
      return c.json({ ok: true, commented: prior.issueId });
    }
  }

  const files = mail.attachments
    .filter((a) => a.disposition !== "inline" || a.filename)
    .slice(0, MAX_ATTACHMENTS)
    .map((a) => ({ filename: safeName(a.filename ?? "attachment"), contentType: a.mimeType || "application/octet-stream", body: Buffer.from(a.content as ArrayBuffer) }))
    .filter((f) => f.body.length <= MAX_ATTACHMENT_BYTES);
  const title = (mail.subject?.trim() || text.split("\n")[0] || "Email request").slice(0, 200);
  const issue = await createFromRequest(deps, ch, {
    title, description: text.slice(0, 10_000), email: fromAddress, name: from?.name || null, messageId: mail.messageId ?? null, via: "email", files,
  });
  return c.json({ ok: true, issue: `${issue.key}-${issue.number}` }, 201);
});

// ─── tell the requester when it's resolved (job every 5 minutes) ───

export async function notifyResolvedRequests(deps: Deps): Promise<number> {
  const rows = await deps.dbs.system.selectFrom("intakeSubmissions as s")
    .innerJoin("issues as i", "i.id", "s.issueId").innerJoin("workflowStates as st", "st.id", "i.statusId")
    .innerJoin("intakeChannels as ch", "ch.id", "s.channelId").innerJoin("workspaces as w", "w.id", "s.workspaceId")
    .select(["s.issueId", "s.submitterEmail", "s.submitterName", "i.title", "st.category", "w.name as workspaceName", "w.id as workspaceId"])
    .where("s.submitterEmail", "is not", null).where("s.resolvedNotifiedAt", "is", null).where("ch.notifySubmitter", "=", true)
    .where("st.category", "in", ["completed", "canceled"]).where("w.status", "in", ["active", "grace"]).limit(200).execute();
  let sent = 0;
  for (const r of rows) {
    // Claim first so a crash never sends twice.
    const claimed = await deps.dbs.system.updateTable("intakeSubmissions").set({ resolvedNotifiedAt: new Date() })
      .where("issueId", "=", r.issueId).where("resolvedNotifiedAt", "is", null).returning("issueId").executeTakeFirst();
    if (!claimed) continue;
    const done = r.category === "completed";
    const lines = [
      `Hi${r.submitterName ? ` ${r.submitterName}` : ""},`,
      done ? `Your request "${r.title}" to ${r.workspaceName} has been done.` : `Your request "${r.title}" to ${r.workspaceName} was closed without changes.`,
      "Thank you for sending it in.",
    ];
    try {
      const { text, html } = layout(done ? "Your request is done" : "Your request was closed", lines);
      await deps.mailer.send({ to: r.submitterEmail!, subject: `${done ? "Done" : "Closed"}: ${r.title}`.slice(0, 150), text, html, workspaceId: r.workspaceId });
      sent++;
    } catch (err) {
      logger.warn({ err, issueId: r.issueId }, "request resolution email failed");
    }
  }
  return sent;
}
