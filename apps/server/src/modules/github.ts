import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { type AppEnv, requireRole, requireUser } from "../context";
import { asWorkspace, notify, type Tx } from "../db/tenant";
import { ApiError } from "../lib/errors";
import { newToken, uuid7 } from "../lib/ids";
import { audit } from "./audit";

/** Finds issue keys like ENG-123 in text. */
export function findIssueKeys(...texts: (string | null | undefined)[]): { key: string; number: number }[] {
  const out = new Map<string, { key: string; number: number }>();
  for (const t of texts) {
    for (const m of (t ?? "").matchAll(/(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,4})-(\d{1,9})(?![0-9])/g)) {
      const key = m[1]!.toUpperCase();
      const number = Number(m[2]);
      out.set(`${key}-${number}`, { key, number });
    }
  }
  return [...out.values()].slice(0, 20);
}

export function verifyGithubSignature(secret: string, raw: string, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`);
  const got = Buffer.from(header);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

interface PullRequestEvent {
  action: string;
  pull_request: { html_url: string; number: number; title: string; body: string | null; state: string; merged: boolean; head?: { ref?: string } };
  repository?: { full_name?: string };
}

async function linkPullRequest(trx: Tx, workspaceId: string, ev: PullRequestEvent, moveOnMerge: boolean): Promise<string[]> {
  const pr = ev.pull_request;
  const keys = findIssueKeys(pr.title, pr.body, pr.head?.ref);
  if (keys.length === 0) return [];
  const issues = await trx.selectFrom("issues as i").innerJoin("teams as t", "t.id", "i.teamId")
    .select(["i.id", "i.teamId", "i.statusId", "i.number", "t.key"])
    .where((eb) => eb.or(keys.map((k) => eb.and([
      eb("i.number", "=", k.number),
      eb.or([eb("t.key", "=", k.key), eb("i.teamId", "in", eb.selectFrom("teamKeyAliases").select("teamId").where("key", "=", k.key))]),
    ]))))
    .execute();
  const state = pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open";
  const title = `${ev.repository?.full_name ? `${ev.repository.full_name}#` : "#"}${pr.number} ${pr.title}`.slice(0, 300);
  const linked: string[] = [];
  for (const issue of issues) {
    const existing = await trx.selectFrom("issueLinks").select(["id", "state"]).where("issueId", "=", issue.id).where("url", "=", pr.html_url).executeTakeFirst();
    if (existing) {
      await trx.updateTable("issueLinks").set({ title, state, updatedAt: new Date() }).where("id", "=", existing.id).execute();
    } else {
      await trx.insertInto("issueLinks").values({ id: uuid7(), workspaceId, issueId: issue.id, provider: "github", url: pr.html_url, title, state }).execute();
      await trx.insertInto("activity").values({ workspaceId, issueId: issue.id, actorId: null, kind: "pr_linked", data: JSON.stringify({ url: pr.html_url, title }) }).execute();
    }
    if (state === "merged" && existing?.state !== "merged") {
      await trx.insertInto("activity").values({ workspaceId, issueId: issue.id, actorId: null, kind: "pr_merged", data: JSON.stringify({ url: pr.html_url, title }) }).execute();
      if (moveOnMerge) {
        const cur = await trx.selectFrom("workflowStates").select("category").where("id", "=", issue.statusId).executeTakeFirst();
        if (cur && cur.category !== "completed" && cur.category !== "canceled") {
          const done = await trx.selectFrom("workflowStates").select("id").where("teamId", "=", issue.teamId).where("category", "=", "completed")
            .orderBy("position").executeTakeFirst();
          if (done) {
            await trx.updateTable("issues").set({ statusId: done.id, completedAt: new Date(), canceledAt: null, updatedAt: new Date() }).where("id", "=", issue.id).execute();
            await trx.insertInto("activity").values({ workspaceId, issueId: issue.id, actorId: null, kind: "status", data: JSON.stringify({ from: issue.statusId, to: done.id, via: "github", url: pr.html_url }) }).execute();
          }
        }
      }
    }
    await notify(trx, workspaceId, { t: "issue", id: issue.id });
    linked.push(`${issue.key}-${issue.number}`);
  }
  return linked;
}

/** POST /api/v1/github/webhook/:workspaceId: one URL and secret per workspace, set as a repository webhook. */
export const githubWebhookRoutes = new Hono<AppEnv>().post("/webhook/:workspaceId", async (c) => {
  const deps = c.get("deps");
  const workspaceId = c.req.param("workspaceId");
  const raw = await c.req.text();
  const integ = /^[0-9a-f-]{36}$/i.test(workspaceId)
    ? await deps.dbs.system.selectFrom("githubIntegrations as g").innerJoin("workspaces as w", "w.id", "g.workspaceId")
        .select(["g.secret", "g.moveOnMerge", "w.status"]).where("g.workspaceId", "=", workspaceId).executeTakeFirst()
    : undefined;
  if (!integ || !verifyGithubSignature(integ.secret, raw, c.req.header("x-hub-signature-256"))) {
    throw new ApiError(401, "bad_signature", "Invalid signature");
  }
  if (integ.status === "deleting" || integ.status === "read_only") return c.json({ ok: true, skipped: integ.status });
  const event = c.req.header("x-github-event");
  if (event === "ping") return c.json({ ok: true, pong: true });
  if (event !== "pull_request") return c.json({ ok: true, ignored: event });
  const ev = JSON.parse(raw) as PullRequestEvent;
  if (!["opened", "edited", "reopened", "closed", "synchronize", "ready_for_review"].includes(ev.action)) return c.json({ ok: true, ignored: ev.action });
  const linked = await asWorkspace(deps.dbs.app, workspaceId, (trx) => linkPullRequest(trx, workspaceId, ev, integ.moveOnMerge));
  return c.json({ ok: true, linked });
});

export const githubSettingsRoutes = new Hono<AppEnv>()
  .get("/integrations/github", async (c) => {
    requireRole(c, "admin");
    const ws = c.get("ws");
    const row = await c.get("trx").selectFrom("githubIntegrations").select(["secret", "moveOnMerge", "createdAt"]).where("workspaceId", "=", ws.id).executeTakeFirst();
    const url = `${c.get("deps").config.APP_URL.replace(/\/$/, "")}/api/v1/github/webhook/${ws.id}`;
    return c.json(row ? { enabled: true, webhookUrl: url, secret: row.secret, moveOnMerge: row.moveOnMerge } : { enabled: false, webhookUrl: url });
  })
  .put("/integrations/github", async (c) => {
    requireRole(c, "admin");
    const user = requireUser(c);
    const ws = c.get("ws");
    const body = z.object({ moveOnMerge: z.boolean().default(true), rotateSecret: z.boolean().default(false) }).parse(await c.req.json());
    const trx = c.get("trx");
    const existing = await trx.selectFrom("githubIntegrations").select("secret").where("workspaceId", "=", ws.id).executeTakeFirst();
    const secret = !existing || body.rotateSecret ? newToken() : existing.secret;
    await trx.insertInto("githubIntegrations").values({ workspaceId: ws.id, secret, moveOnMerge: body.moveOnMerge, createdBy: user.id })
      .onConflict((oc) => oc.column("workspaceId").doUpdateSet({ secret, moveOnMerge: body.moveOnMerge })).execute();
    await audit(c, existing ? "github.updated" : "github.enabled", "integration", ws.id, { moveOnMerge: body.moveOnMerge, rotatedSecret: Boolean(existing && body.rotateSecret) });
    return c.json({ enabled: true, webhookUrl: `${c.get("deps").config.APP_URL.replace(/\/$/, "")}/api/v1/github/webhook/${ws.id}`, secret, moveOnMerge: body.moveOnMerge });
  })
  .delete("/integrations/github", async (c) => {
    requireRole(c, "admin");
    await c.get("trx").deleteFrom("githubIntegrations").where("workspaceId", "=", c.get("ws").id).execute();
    await audit(c, "github.disabled", "integration", c.get("ws").id);
    return c.json({ ok: true });
  });

