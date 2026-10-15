import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runRecurring } from "../src/modules/templates";
import { Client, createHarness, type Harness, setupWorkspace } from "./harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ SSO_ALLOW_PRIVATE: "true" });
});
beforeEach(async () => {
  await h.reset();
});
afterAll(async () => {
  await h?.close();
});

async function teamOf2() {
  const a = await setupWorkspace(h, "ann@acme.co", "acme");
  const inv = await a.c.ok("POST", "/api/v1/w/acme/invites", { role: "member" });
  const ben = await new Client(h).login("ben@acme.co", "Ben");
  await ben.ok("POST", `/api/v1/invites/${inv.url.split("/").pop()}/accept`);
  return { ...a, ben, annId: (await a.c.ok("GET", "/api/v1/me")).id as string, benId: (await ben.ok("GET", "/api/v1/me")).id as string };
}

describe("multiple assignees", () => {
  it("assigns several people, notifies each, filters and records changes", async () => {
    const { c, team, ben, annId, benId } = await teamOf2();
    const i = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "pair on it", assigneeIds: [annId, benId] });
    expect(i.assigneeIds.sort()).toEqual([annId, benId].sort());
    expect((await ben.ok("GET", "/api/v1/w/acme/notifications"))[0].kind).toBe("assigned");
    expect((await c.ok("GET", `/api/v1/w/acme/issues?assignee=${benId}`)).issues).toHaveLength(1);
    await c.ok("PATCH", `/api/v1/w/acme/issues/${i.id}`, { assigneeIds: [benId] });
    expect((await c.ok("GET", "/api/v1/w/acme/issues?assignee=me")).issues).toHaveLength(0);
    const acts = await c.ok("GET", `/api/v1/w/acme/issues/${i.id}/activity`);
    expect(acts.at(-1)).toMatchObject({ kind: "assignees", data: { added: [], removed: [annId] } });
    await c.ok("PATCH", `/api/v1/w/acme/issues/${i.id}`, { assigneeIds: [] });
    expect((await c.ok("GET", "/api/v1/w/acme/issues?assignee=none")).issues).toHaveLength(1);
    expect((await c.patch(`/api/v1/w/acme/issues/${i.id}`, { assigneeIds: ["00000000-0000-4000-8000-000000000000"] })).status).toBe(400);
  });
});

describe("custom fields", () => {
  it("validates by type, filters, and cleans up removed options", async () => {
    const { c, team, annId, ben } = await teamOf2();
    const sev = await c.ok("POST", "/api/v1/w/acme/fields", { name: "Severity", type: "select", options: [{ id: "s1", name: "S1" }, { id: "s2", name: "S2" }] });
    const areas = await c.ok("POST", "/api/v1/w/acme/fields", { name: "Areas", type: "multi_select", options: [{ id: "api", name: "API" }, { id: "ui", name: "UI" }] });
    const points = await c.ok("POST", "/api/v1/w/acme/fields", { name: "Customer", type: "user" });
    const ok = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "a", fields: { [sev.id]: "s1", [areas.id]: ["api", "ui"], [points.id]: annId } });
    expect(ok.fields).toEqual({ [sev.id]: "s1", [areas.id]: ["api", "ui"], [points.id]: annId });
    await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "b", fields: { [sev.id]: "s2" } });
    for (const bad of [{ [sev.id]: "nope" }, { [areas.id]: ["x"] }, { [points.id]: "00000000-0000-4000-8000-000000000000" }]) {
      expect((await c.post("/api/v1/w/acme/issues", { teamId: team.id, title: "x", fields: bad })).status).toBe(400);
    }
    const titles = async (q: string) => (await c.ok("GET", `/api/v1/w/acme/issues?${q}`)).issues.map((i: { title: string }) => i.title).sort();
    expect(await titles(`field=${sev.id}:s1`)).toEqual(["a"]);
    expect(await titles(`field=${areas.id}:ui`)).toEqual(["a"]);
    expect(await titles(`field=${areas.id}:none`)).toEqual(["b"]);
    await c.ok("PATCH", `/api/v1/w/acme/issues/${ok.id}`, { fields: { [sev.id]: null } });
    expect((await c.ok("GET", `/api/v1/w/acme/issues/${ok.id}`)).fields[sev.id]).toBeUndefined();
    await c.ok("PATCH", `/api/v1/w/acme/fields/${areas.id}`, { options: [{ id: "api", name: "API" }] });
    expect((await c.ok("GET", `/api/v1/w/acme/issues/${ok.id}`)).fields[areas.id]).toEqual(["api"]);
    expect((await ben.post("/api/v1/w/acme/fields", { name: "X", type: "text" })).status).toBe(403);
    const other = await c.ok("POST", "/api/v1/w/acme/teams", { name: "Ops", key: "OPS" });
    const opsField = await c.ok("POST", "/api/v1/w/acme/fields", { name: "Pager", type: "checkbox", teamId: other.id });
    expect((await c.post("/api/v1/w/acme/issues", { teamId: team.id, title: "x", fields: { [opsField.id]: true } })).status).toBe(400);
  });
});

describe("time tracking", () => {
  it("logs time, runs a timer, reports totals and protects others' entries", async () => {
    const { c, team, ben, annId, benId } = await teamOf2();
    const i = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "timed" });
    const e = await c.ok("POST", `/api/v1/w/acme/issues/${i.id}/time`, { minutes: 90, spentOn: "2026-10-01", note: "design" });
    await ben.ok("POST", `/api/v1/w/acme/issues/${i.id}/time`, { minutes: 30, spentOn: "2026-10-02" });
    await ben.ok("POST", `/api/v1/w/acme/issues/${i.id}/timer/start`);
    await sql`UPDATE active_timers SET started_at = now() - interval '25 minutes'`.execute(h.deps.dbs.owner);
    expect((await ben.ok("GET", "/api/v1/w/acme/timer")).identifier).toBe("ACME-1");
    const stopped = await ben.ok("POST", "/api/v1/w/acme/timer/stop");
    expect(stopped.minutes).toBe(25);
    expect((await ben.post("/api/v1/w/acme/timer/stop")).status).toBe(400);
    const d = await c.ok("GET", `/api/v1/w/acme/issues/${i.id}`);
    expect(d.timeSpentMinutes).toBe(145);
    const report = await c.ok("GET", "/api/v1/w/acme/time?from=2026-01-01&to=2099-01-01");
    expect(report.totalMinutes).toBe(145);
    expect(report.byUser).toEqual([{ userId: annId, minutes: 90 }, { userId: benId, minutes: 55 }]);
    expect((await ben.patch(`/api/v1/w/acme/time/${e.id}`, { minutes: 5 })).status).toBe(403);
    await c.ok("DELETE", `/api/v1/w/acme/time/${e.id}`);
    expect((await c.post(`/api/v1/w/acme/issues/${i.id}/time`, { minutes: 0, spentOn: "2026-10-01" })).status).toBe(400);
  });
});

describe("templates and recurring issues", () => {
  it("creates issues from a template on schedule, once per due run", async () => {
    const { c, team, annId } = await teamOf2();
    const label = await c.ok("POST", "/api/v1/w/acme/labels", { name: "chore", color: "#334455" });
    const field = await c.ok("POST", "/api/v1/w/acme/fields", { name: "Kind", type: "text" });
    const t = await c.ok("POST", "/api/v1/w/acme/templates", {
      teamId: team.id, name: "Weekly review", title: "Weekly review", description: "Check the board", priority: 2,
      labelIds: [label.id], assigneeIds: [annId], fields: { [field.id]: "ritual" },
    });
    const r = await c.ok("POST", "/api/v1/w/acme/recurring", { templateId: t.id, frequency: "daily", startsOn: "2026-01-01", hour: 9, timezone: "Europe/London" });
    expect(new Date(r.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    // Pretend three runs were missed while the server was down.
    await sql`UPDATE recurring_issues SET next_run_at = now() - interval '3 days'`.execute(h.deps.dbs.owner);
    expect(await runRecurring(h.deps)).toBe(1);
    expect(await runRecurring(h.deps)).toBe(0);
    const issues = (await c.ok("GET", "/api/v1/w/acme/issues")).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ title: "Weekly review", priority: 2, labelIds: [label.id], assigneeIds: [annId], fields: { [field.id]: "ritual" } });
    const acts = await c.ok("GET", `/api/v1/w/acme/issues/${issues[0].id}/activity`);
    expect(acts[0]).toMatchObject({ kind: "created", data: { recurringId: r.id, templateId: t.id } });
    const after = (await c.ok("GET", "/api/v1/w/acme/recurring"))[0];
    expect(after.lastIssueId).toBe(issues[0].id);
    expect(new Date(after.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    expect((await c.post("/api/v1/w/acme/recurring", { templateId: t.id, frequency: "daily", startsOn: "2026-01-01", timezone: "Mars/Olympus" })).status).toBe(400);
    await c.ok("DELETE", `/api/v1/w/acme/templates/${t.id}`);
    expect(await c.ok("GET", "/api/v1/w/acme/recurring")).toEqual([]);
  });

  it("validates templates like issues", async () => {
    const { c, team } = await teamOf2();
    expect((await c.post("/api/v1/w/acme/templates", { teamId: team.id, name: "x", title: "x", assigneeIds: ["00000000-0000-4000-8000-000000000000"] })).status).toBe(400);
  });
});

describe("audit log", () => {
  it("records admin actions, is admin-only and append-only", async () => {
    const { c, ben, benId } = await teamOf2();
    await c.ok("PATCH", "/api/v1/w/acme", { name: "Acme Inc" });
    await c.ok("PATCH", `/api/v1/w/acme/members/${benId}`, { role: "guest" });
    await c.ok("POST", "/api/v1/w/acme/tokens", { name: "ci" });
    const log = await c.ok("GET", "/api/v1/w/acme/audit");
    expect(log.entries.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(["workspace.renamed", "member.role_changed", "token.created", "invite.created", "invite.accepted"]),
    );
    const role = log.entries.find((e: { action: string }) => e.action === "member.role_changed");
    expect(role).toMatchObject({ actorLabel: "ann@acme.co", targetId: benId, data: { from: "member", to: "guest" } });
    expect((await ben.get("/api/v1/w/acme/audit")).status).toBe(403);
    const csv = await c.req("GET", "/api/v1/w/acme/audit.csv");
    expect(String(csv.body)).toContain("member.role_changed");
    await expect(sql`UPDATE audit_log SET action = 'x'`.execute(h.deps.dbs.system)).rejects.toThrow(/append-only/);
    const app = await h.deps.dbs.app.transaction().execute(async (trx) => {
      const ws = (await c.ok("GET", "/api/v1/w/acme")).id;
      await sql`SELECT set_config('app.workspace_id', ${ws}, true)`.execute(trx);
      return sql`DELETE FROM audit_log`.execute(trx).then(() => "deleted", (e: { code?: string }) => e.code);
    });
    expect(app).toBe("42501");
  });
});

describe("SSO (OIDC)", () => {
  let server: Server;
  let issuer = "";
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let nextClaims: Record<string, unknown> = {};
  const codes = new Map<string, { nonce: string; challenge: string }>();

  beforeAll(async () => {
    keys = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", issuer);
      if (url.pathname === "/.well-known/openid-configuration") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, token_endpoint_auth_methods_supported: ["client_secret_basic"] }));
      } else if (url.pathname === "/jwks") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ keys: [jwk] }));
      } else if (url.pathname === "/token") {
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", async () => {
          const form = new URLSearchParams(body);
          const auth = Buffer.from((req.headers.authorization ?? "").replace("Basic ", ""), "base64").toString();
          const entry = codes.get(form.get("code") ?? "");
          const verifierOk = entry && createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === entry.challenge;
          if (auth !== "client-1:s3cret" || !entry || !verifierOk) {
            res.statusCode = 400;
            return res.end(JSON.stringify({ error: "invalid_grant" }));
          }
          const idToken = await new SignJWT({ nonce: entry.nonce, email_verified: true, ...nextClaims })
            .setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(issuer).setAudience("client-1").setSubject("u1")
            .setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ access_token: "x", token_type: "Bearer", id_token: idToken }));
        });
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  /** Runs the browser part: start, "approve" at the provider, callback. Returns the final redirect. */
  async function ssoLogin(client: Client, slug: string, claims: Record<string, unknown>) {
    nextClaims = claims;
    const start = await client.req("GET", `/api/v1/auth/sso/${slug}/start`);
    const authorize = new URL(start.headers.get("location")!);
    const code = `code-${Math.random()}`;
    codes.set(code, { nonce: authorize.searchParams.get("nonce")!, challenge: authorize.searchParams.get("code_challenge")! });
    const cb = await client.req("GET", `/api/v1/auth/sso/callback?code=${code}&state=${authorize.searchParams.get("state")}`);
    return { authorize, location: cb.headers.get("location") };
  }

  async function configure(c: Client, extra: Record<string, unknown> = {}) {
    return c.ok("PUT", "/api/v1/w/acme/sso", { issuer, clientId: "client-1", clientSecret: "s3cret", allowedDomains: ["acme.co"], autoJoinRole: "member", ...extra });
  }

  it("signs people in through the workspace's provider and joins them by domain", async () => {
    const { c } = await setupWorkspace(h, "ann@acme.co", "acme");
    const cfg = await configure(c);
    expect(cfg).toMatchObject({ enabled: true, issuer, clientId: "client-1", hasSecret: true, allowedDomains: ["acme.co"] });
    expect(JSON.stringify(cfg)).not.toContain("s3cret");
    expect((await new Client(h).ok("POST", "/api/v1/auth/sso/discover", { email: "x@acme.co" })).workspaces).toEqual([{ slug: "acme", name: "ACME" }]);

    const dee = new Client(h);
    const { authorize, location } = await ssoLogin(dee, "acme", { email: "dee@acme.co", name: "Dee" });
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("redirect_uri")).toBe("http://localhost:3999/api/v1/auth/sso/callback");
    expect(location).toBe("/acme");
    const me = await dee.ok("GET", "/api/v1/me");
    expect(me).toMatchObject({ email: "dee@acme.co", name: "Dee", workspaces: [{ slug: "acme", role: "member" }] });
    const audit = await c.ok("GET", "/api/v1/w/acme/audit");
    expect(audit.entries.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(["sso.configured", "member.joined_via_sso", "sso.login"]));
  });

  it("rejects other domains, unverified emails, bad nonces and non-members without auto-join", async () => {
    const { c } = await setupWorkspace(h, "ann@acme.co", "acme");
    await configure(c);
    expect((await ssoLogin(new Client(h), "acme", { email: "eve@evil.co" })).location).toBe("/login?error=sso_domain");
    expect((await ssoLogin(new Client(h), "acme", { email: "dee@acme.co", email_verified: false })).location).toBe("/login?error=sso_email_unverified");
    expect((await ssoLogin(new Client(h), "acme", { email: "dee@acme.co", nonce: "forged" })).location).toBe("/login?error=sso_failed");
    await configure(c, { autoJoinRole: null });
    expect((await ssoLogin(new Client(h), "acme", { email: "new@acme.co" })).location).toBe("/login?error=sso_not_member");
    // A pending email invite lets them in even without auto-join.
    await c.ok("POST", "/api/v1/w/acme/invites", { email: "new@acme.co", role: "guest" });
    const ok = new Client(h);
    expect((await ssoLogin(ok, "acme", { email: "new@acme.co" })).location).toBe("/acme");
    expect((await ok.ok("GET", "/api/v1/me")).workspaces[0].role).toBe("guest");
    // A state that doesn't match the cookie is refused.
    const x = new Client(h);
    await x.req("GET", "/api/v1/auth/sso/acme/start");
    expect((await x.req("GET", "/api/v1/auth/sso/callback?code=c&state=wrong")).headers.get("location")).toBe("/login?error=sso_state");
  });

  it("'SSO only' blocks members who signed in another way, but not admins", async () => {
    const { c, team } = await teamOf2();
    await configure(c, { enforce: true });
    const benMagic = await new Client(h).login("ben@acme.co");
    const r = await benMagic.get("/api/v1/w/acme/issues");
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("sso_required");
    expect((await c.get("/api/v1/w/acme/issues")).status).toBe(200); // admin, signed in by email link
    const benSso = new Client(h);
    await ssoLogin(benSso, "acme", { email: "ben@acme.co" });
    expect((await benSso.get("/api/v1/w/acme/issues")).status).toBe(200);
    expect((await benSso.post("/api/v1/w/acme/issues", { teamId: team.id, title: "via sso" })).status).toBe(201);
    expect((await c.put("/api/v1/w/acme/sso", { issuer, clientId: "client-1", allowedDomains: [], enforce: true })).status).toBe(400);
  });

  it("stores the client secret encrypted and out of the app role's reach", async () => {
    const { c } = await setupWorkspace(h, "ann@acme.co", "acme");
    await configure(c);
    const row = await h.deps.dbs.owner.selectFrom("ssoConfigs").select("clientSecretEnc").executeTakeFirstOrThrow();
    expect(row.clientSecretEnc).toMatch(/^v1\./);
    expect(row.clientSecretEnc).not.toContain("s3cret");
    const ws = (await c.ok("GET", "/api/v1/w/acme")).id;
    const res = await h.deps.dbs.app.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.workspace_id', ${ws}, true)`.execute(trx);
      return sql`SELECT client_secret_enc FROM sso_configs`.execute(trx).then(() => "read", (e: { code?: string }) => e.code);
    });
    expect(res).toBe("42501");
    // Updating without a secret keeps the stored one.
    await c.ok("PUT", "/api/v1/w/acme/sso", { issuer, clientId: "client-1", allowedDomains: ["acme.co"], autoJoinRole: "member" });
    expect((await ssoLogin(new Client(h), "acme", { email: "zed@acme.co" })).location).toBe("/acme");
    await c.ok("DELETE", "/api/v1/w/acme/sso");
    expect((await new Client(h).req("GET", "/api/v1/auth/sso/acme/start")).headers.get("location")).toBe("/login?error=sso_not_configured");
  });

  it("refuses providers that can't be reached or don't match", async () => {
    const { c } = await setupWorkspace(h, "ann@acme.co", "acme");
    const r = await c.put("/api/v1/w/acme/sso", { issuer: "http://127.0.0.1:9", clientId: "x", clientSecret: "y", allowedDomains: ["acme.co"] });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("Couldn't read the provider's settings");
  });
});
