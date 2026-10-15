import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { GIT_PROVIDERS, type GitIntegration, type GitProvider } from "@glasstrack/shared";
import { type AppEnv, type Deps, requireRole, requireUser } from "../context";
import { asWorkspace } from "../db/tenant";
import { ApiError, notFound } from "../lib/errors";
import { newToken } from "../lib/ids";
import { audit } from "./audit";
import { type ChangeRequest, linkPullRequest } from "./github";

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Gitea and Forgejo sign the body with HMAC-SHA256 as plain hex (no "sha256=" prefix). */
export function verifyGiteaSignature(secret: string, raw: string, header: string | undefined): boolean {
  if (!header) return false;
  return safeEqual(createHmac("sha256", secret).update(raw).digest("hex"), header.trim().toLowerCase());
}

interface GitlabMergeRequestEvent {
  object_kind: string;
  object_attributes: { iid: number; title: string; description: string | null; url: string; state: string; action?: string; source_branch?: string };
  project?: { path_with_namespace?: string };
}

export function fromGitlab(ev: GitlabMergeRequestEvent): ChangeRequest {
  const mr = ev.object_attributes;
  return {
    provider: "gitlab", url: mr.url, number: mr.iid, title: mr.title, body: mr.description, branch: mr.source_branch, repo: ev.project?.path_with_namespace,
    state: mr.state === "merged" ? "merged" : mr.state === "closed" || mr.state === "locked" ? "closed" : "open",
  };
}

interface GiteaPullRequestEvent {
  action: string;
  pull_request: { html_url: string; number: number; title: string; body: string | null; state: string; merged: boolean; head?: { ref?: string } };
  repository?: { full_name?: string };
}

export function fromGitea(ev: GiteaPullRequestEvent): ChangeRequest {
  const pr = ev.pull_request;
  return {
    provider: "gitea", url: pr.html_url, number: pr.number, title: pr.title, body: pr.body, branch: pr.head?.ref, repo: ev.repository?.full_name,
    state: pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open",
  };
}

const webhookUrl = (deps: Deps, provider: GitProvider, workspaceId: string) =>
  `${deps.config.APP_URL.replace(/\/$/, "")}/api/v1/git/${provider}/webhook/${workspaceId}`;

/**
 * POST /api/v1/git/:provider/webhook/:workspaceId
 * GitLab: "Merge request events", secret token sent as X-Gitlab-Token.
 * Gitea/Forgejo: "Pull request" events, body signed with the secret.
 */
export const gitForgeWebhookRoutes = new Hono<AppEnv>().post("/:provider/webhook/:workspaceId", async (c) => {
  const deps = c.get("deps");
  const provider = c.req.param("provider") as GitProvider;
  const workspaceId = c.req.param("workspaceId");
  if (!GIT_PROVIDERS.includes(provider)) throw notFound();
  const raw = await c.req.text();
  const integ = /^[0-9a-f-]{36}$/i.test(workspaceId)
    ? await deps.dbs.system.selectFrom("gitIntegrations as g").innerJoin("workspaces as w", "w.id", "g.workspaceId")
        .select(["g.secret", "g.moveOnMerge", "w.status"]).where("g.workspaceId", "=", workspaceId).where("g.provider", "=", provider).executeTakeFirst()
    : undefined;
  const ok = integ && (provider === "gitlab"
    ? safeEqual(integ.secret, c.req.header("x-gitlab-token") ?? "")
    : verifyGiteaSignature(integ.secret, raw, c.req.header("x-forgejo-signature") ?? c.req.header("x-gitea-signature")));
  if (!integ || !ok) throw new ApiError(401, "bad_signature", "Invalid secret or signature");
  if (integ.status === "deleting" || integ.status === "read_only") return c.json({ ok: true, skipped: integ.status });

  let cr: ChangeRequest;
  if (provider === "gitlab") {
    const event = c.req.header("x-gitlab-event");
    if (event !== "Merge Request Hook") return c.json({ ok: true, ignored: event ?? null });
    cr = fromGitlab(JSON.parse(raw) as GitlabMergeRequestEvent);
  } else {
    const event = c.req.header("x-forgejo-event") ?? c.req.header("x-gitea-event");
    if (event !== "pull_request") return c.json({ ok: true, ignored: event ?? null });
    const ev = JSON.parse(raw) as GiteaPullRequestEvent;
    if (!["opened", "edited", "reopened", "closed", "synchronized"].includes(ev.action)) return c.json({ ok: true, ignored: ev.action });
    cr = fromGitea(ev);
  }
  const { linked, moved } = await asWorkspace(deps.dbs.app, workspaceId, (trx) => linkPullRequest(trx, workspaceId, cr, integ.moveOnMerge));
  for (const m of moved) {
    await deps.jobs.send("automation.event", { workspaceId, issueId: m.issueId, actorId: "", events: [{ type: "status_changed", toStatusId: m.statusId, toCategory: "completed" }] }).catch(() => undefined);
  }
  return c.json({ ok: true, linked });
});

export const gitForgeSettingsRoutes = new Hono<AppEnv>()
  .get("/integrations/:provider{gitlab|gitea}", async (c) => {
    requireRole(c, "admin");
    const provider = c.req.param("provider") as GitProvider;
    const ws = c.get("ws");
    const row = await c.get("trx").selectFrom("gitIntegrations").select(["secret", "moveOnMerge"]).where("provider", "=", provider).executeTakeFirst();
    const url = webhookUrl(c.get("deps"), provider, ws.id);
    return c.json((row ? { provider, enabled: true, webhookUrl: url, secret: row.secret, moveOnMerge: row.moveOnMerge } : { provider, enabled: false, webhookUrl: url }) satisfies GitIntegration);
  })
  .put("/integrations/:provider{gitlab|gitea}", async (c) => {
    requireRole(c, "admin");
    const user = requireUser(c);
    const provider = c.req.param("provider") as GitProvider;
    const ws = c.get("ws");
    const body = z.object({ moveOnMerge: z.boolean().default(true), rotateSecret: z.boolean().default(false) }).parse(await c.req.json());
    const trx = c.get("trx");
    const existing = await trx.selectFrom("gitIntegrations").select("secret").where("provider", "=", provider).executeTakeFirst();
    const secret = !existing || body.rotateSecret ? newToken() : existing.secret;
    await trx.insertInto("gitIntegrations").values({ workspaceId: ws.id, provider, secret, moveOnMerge: body.moveOnMerge, createdBy: user.id })
      .onConflict((oc) => oc.columns(["workspaceId", "provider"]).doUpdateSet({ secret, moveOnMerge: body.moveOnMerge })).execute();
    await audit(c, existing ? `${provider}.updated` : `${provider}.enabled`, "integration", ws.id, { moveOnMerge: body.moveOnMerge, rotatedSecret: Boolean(existing && body.rotateSecret) });
    return c.json({ provider, enabled: true, webhookUrl: webhookUrl(c.get("deps"), provider, ws.id), secret, moveOnMerge: body.moveOnMerge } satisfies GitIntegration);
  })
  .delete("/integrations/:provider{gitlab|gitea}", async (c) => {
    requireRole(c, "admin");
    const provider = c.req.param("provider") as GitProvider;
    await c.get("trx").deleteFrom("gitIntegrations").where("provider", "=", provider).execute();
    await audit(c, `${provider}.disabled`, "integration", c.get("ws").id);
    return c.json({ ok: true });
  });
