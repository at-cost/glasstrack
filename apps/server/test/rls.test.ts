import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Client, createHarness, type Harness, setupWorkspace } from "./harness";

/**
 * Tenant isolation. Two workspaces with data in every tenant table; a member
 * of A must never read, change or create anything in B, through the API or
 * directly as the tracker_app database role.
 */

let h: Harness;
let a: { c: Client; slug: string; team: { id: string } };
let b: { c: Client; slug: string; team: { id: string } };
let bIssue: { id: string; identifier: string };
let bWorkspaceId: string;

const TENANT_TABLES_SQL = sql<{ tableName: string }>`
  SELECT c.table_name FROM information_schema.columns c
  JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
  WHERE c.table_schema = 'public' AND c.column_name = 'workspace_id' AND t.table_type = 'BASE TABLE'
  ORDER BY 1`;

async function fillWorkspace(w: { c: Client; slug: string; team: { id: string } }, tag: string) {
  const base = `/api/v1/w/${w.slug}`;
  const label = await w.c.ok("POST", `${base}/labels`, { name: `label-${tag}`, color: "#112233" });
  const cycle = await w.c.ok("POST", `${base}/teams/${w.team.id}/cycles`, { startsOn: "2026-01-01", endsOn: "2026-01-14" });
  const issue = await w.c.ok("POST", `${base}/issues`, {
    teamId: w.team.id, title: `secret ${tag} roadmap`, description: `confidential ${tag}`, labelIds: [label.id], cycleId: cycle.id,
  });
  const other = await w.c.ok("POST", `${base}/issues`, { teamId: w.team.id, title: `other ${tag}` });
  await w.c.ok("POST", `${base}/issues/${issue.id}/relations`, { relatedIssueId: other.id, type: "blocks" });
  await w.c.ok("POST", `${base}/issues/${issue.id}/comments`, { body: `comment ${tag} confidential` });
  await w.c.ok("POST", `${base}/views`, { name: `view ${tag}`, shared: true, filters: {} });
  await w.c.ok("POST", `${base}/invites`, { email: `invitee-${tag}@example.com` });
  await w.c.ok("PUT", `${base}/notification-settings`, { digest: "hourly", events: {} });
  await w.c.ok("POST", `${base}/issues/${issue.id}/attachments`, { filename: "a.txt", contentType: "text/plain", size: 3 });
  await w.c.ok("PUT", `${base}/teams/${w.team.id}/members/${(await w.c.ok("GET", "/api/v1/me")).id}`, {});
  return issue as { id: string; identifier: string };
}

beforeAll(async () => {
  h = await createHarness();
  await h.reset();
  a = await setupWorkspace(h, "alice@a.example", "alpha");
  b = await setupWorkspace(h, "bob@b.example", "bravo");
  await fillWorkspace(a, "A");
  bIssue = await fillWorkspace(b, "B");
  // Notifications + exports in B
  const carol = await setupWorkspace(h, "carol@b.example", "carol-own");
  const inv = await b.c.ok("POST", `/api/v1/w/bravo/invites`, { role: "member" });
  await carol.c.ok("POST", `/api/v1/invites/${inv.url.split("/").pop()}/accept`);
  await carol.c.ok("POST", `/api/v1/w/bravo/issues/${bIssue.id}/comments`, { body: "ping" });
  await b.c.ok("POST", `/api/v1/w/bravo/exports`);
  bWorkspaceId = (await b.c.ok("GET", "/api/v1/w/bravo")).id;
});

afterAll(async () => {
  await h?.close();
});

describe("schema guarantees", () => {
  it("every table with workspace_id has RLS enabled, forced, and a tracker_app policy", async () => {
    const tables = (await TENANT_TABLES_SQL.execute(h.deps.dbs.owner)).rows.map((r) => r.tableName);
    expect(tables.length).toBeGreaterThan(15);
    const rows = await sql<{ relname: string; rls: boolean; force: boolean; policies: string[] }>`
      SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
        coalesce((SELECT array_agg(p.polname) FROM pg_policy p WHERE p.polrelid = c.oid
          AND 'tracker_app'::regrole = ANY(p.polroles)), '{}') AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY(${tables})`.execute(h.deps.dbs.owner);
    for (const r of rows.rows) {
      expect({ table: r.relname, rls: r.rls, force: r.force }).toEqual({ table: r.relname, rls: true, force: true });
      expect(r.policies.length, `${r.relname} has no tracker_app policy`).toBeGreaterThan(0);
    }
  });

  it("tracker_app cannot bypass RLS and is not a superuser", async () => {
    const r = await sql<{ rolsuper: boolean; rolbypassrls: boolean }>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'tracker_app'`.execute(h.deps.dbs.owner);
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe("API isolation", () => {
  it("a non-member gets 404 for every route of another workspace", async () => {
    for (const path of ["", "/members", "/teams", "/states", "/labels", "/cycles", "/issues", "/views", "/notifications", "/exports", "/invites", "/search?q=secret"]) {
      const r = await a.c.get(`/api/v1/w/bravo${path}`);
      expect(r.status, path).toBe(404);
    }
    expect((await a.c.post(`/api/v1/w/bravo/issues`, { teamId: b.team.id, title: "x" })).status).toBe(404);
    expect((await a.c.get(`/api/v1/w/bravo/events`)).status).toBe(404);
  });

  it("issue ids and keys from another workspace are not found inside your own", async () => {
    const base = "/api/v1/w/alpha";
    expect((await a.c.get(`${base}/issues/${bIssue.id}`)).status).toBe(404);
    expect((await a.c.get(`${base}/issues/${bIssue.identifier}`)).status).toBe(404);
    expect((await a.c.patch(`${base}/issues/${bIssue.id}`, { title: "pwned" })).status).toBe(404);
    expect((await a.c.del(`${base}/issues/${bIssue.id}`)).status).toBe(404);
    expect((await a.c.get(`${base}/issues/${bIssue.id}/comments`)).status).toBe(404);
    expect((await a.c.post(`${base}/issues/${bIssue.id}/comments`, { body: "x" })).status).toBe(404);
    expect((await a.c.get(`${base}/issues/${bIssue.id}/activity`)).status).toBe(404);
  });

  it("cross-workspace references are rejected when creating or linking", async () => {
    const base = "/api/v1/w/alpha";
    expect((await a.c.post(`${base}/issues`, { teamId: b.team.id, title: "x" })).status).toBe(404);
    const mine = await a.c.ok("GET", `${base}/issues`);
    const id = mine.issues[0].id;
    expect((await a.c.post(`${base}/issues/${id}/relations`, { relatedIssueId: bIssue.id, type: "related" })).status).toBe(404);
    expect((await a.c.patch(`${base}/issues/${id}`, { parentId: bIssue.id })).status).toBe(400);
    const bLabels = await b.c.ok("GET", "/api/v1/w/bravo/labels");
    expect((await a.c.patch(`${base}/issues/${id}`, { labelIds: [bLabels[0].id] })).status).toBe(400);
    const bob = await b.c.ok("GET", "/api/v1/me");
    expect((await a.c.patch(`${base}/issues/${id}`, { assigneeId: bob.id })).status).toBe(400);
  });

  it("listings and search in your workspace never include the other's rows", async () => {
    const base = "/api/v1/w/alpha";
    const issues = await a.c.ok("GET", `${base}/issues?q=confidential`);
    expect(issues.issues.every((i: { title: string }) => !i.title.includes("B"))).toBe(true);
    const search = await a.c.ok("GET", `${base}/search?q=B`);
    expect(search.issues).toEqual([]);
    const members = await a.c.ok("GET", `${base}/members`);
    expect(members.map((m: { email: string }) => m.email)).toEqual(["alice@a.example"]);
    const labels = await a.c.ok("GET", `${base}/labels`);
    expect(labels.map((l: { name: string }) => l.name)).toEqual(["label-A"]);
  });

  it("only lists the workspaces you belong to", async () => {
    const me = await a.c.ok("GET", "/api/v1/me");
    expect(me.workspaces.map((w: { slug: string }) => w.slug)).toEqual(["alpha"]);
  });
});

describe("database-level isolation as tracker_app", () => {
  it("with workspace A entered, no tenant table returns B rows and writes to B fail", async () => {
    const tables = (await TENANT_TABLES_SQL.execute(h.deps.dbs.owner)).rows.map((r) => r.tableName);
    const alice = await a.c.ok("GET", "/api/v1/me");
    for (const table of tables) {
      await h.deps.dbs.app.transaction().execute(async (trx) => {
        await sql`SELECT set_config('app.user_id', ${alice.id}, true)`.execute(trx);
        await sql`SELECT * FROM app.enter_workspace('alpha')`.execute(trx);
        const seen = await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(table)} WHERE workspace_id = ${bWorkspaceId}`.execute(trx);
        expect(Number(seen.rows[0]!.n), `${table} leaked B rows`).toBe(0);
        const upd = await sql`UPDATE ${sql.table(table)} SET workspace_id = workspace_id WHERE workspace_id = ${bWorkspaceId}`.execute(trx)
          .catch((e: { code?: string }) => ({ numAffectedRows: e.code === "42501" ? 0n : -1n }));
        expect(Number(upd.numAffectedRows ?? 0n), `${table} update reached B`).toBe(0);
      });
    }
  });

  it("B really has rows in every tenant table, so the checks above are not vacuous", async () => {
    const tables = (await TENANT_TABLES_SQL.execute(h.deps.dbs.owner)).rows.map((r) => r.tableName);
    const empty: string[] = [];
    for (const table of tables) {
      const r = await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(table)} WHERE workspace_id = ${bWorkspaceId}`.execute(h.deps.dbs.owner);
      if (Number(r.rows[0]!.n) === 0) empty.push(table);
    }
    // Key aliases only exist after a team rename.
    expect(empty).toEqual(["team_key_aliases"]);
  });

  it("inserting a row tagged with B's workspace_id is rejected", async () => {
    const alice = await a.c.ok("GET", "/api/v1/me");
    await expect(
      h.deps.dbs.app.transaction().execute(async (trx) => {
        await sql`SELECT set_config('app.user_id', ${alice.id}, true)`.execute(trx);
        await sql`SELECT * FROM app.enter_workspace('alpha')`.execute(trx);
        await sql`INSERT INTO labels (id, workspace_id, name, color) VALUES (gen_random_uuid(), ${bWorkspaceId}, 'evil', '#000000')`.execute(trx);
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("entering a workspace you are not a member of fails", async () => {
    const alice = await a.c.ok("GET", "/api/v1/me");
    await expect(
      h.deps.dbs.app.transaction().execute(async (trx) => {
        await sql`SELECT set_config('app.user_id', ${alice.id}, true)`.execute(trx);
        await sql`SELECT * FROM app.enter_workspace('bravo')`.execute(trx);
      }),
    ).rejects.toThrow(/workspace not found/);
  });

  it("without any workspace context, tenant tables are empty", async () => {
    const tables = (await TENANT_TABLES_SQL.execute(h.deps.dbs.owner)).rows.map((r) => r.tableName);
    for (const table of tables) {
      const r = await h.deps.dbs.app.transaction().execute((trx) =>
        sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(trx),
      );
      expect(Number(r.rows[0]!.n), table).toBe(0);
    }
  });

  it("the workspace setting does not leak between pooled connections", async () => {
    const alice = await a.c.ok("GET", "/api/v1/me");
    await h.deps.dbs.app.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.user_id', ${alice.id}, true)`.execute(trx);
      await sql`SELECT * FROM app.enter_workspace('alpha')`.execute(trx);
    });
    for (let i = 0; i < 10; i++) {
      const r = await sql<{ ws: string | null }>`SELECT app.ws()::text AS ws`.execute(h.deps.dbs.app);
      expect(r.rows[0]!.ws).toBeNull();
    }
  });

  it("users of other workspaces are invisible", async () => {
    const alice = await a.c.ok("GET", "/api/v1/me");
    const r = await h.deps.dbs.app.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.user_id', ${alice.id}, true)`.execute(trx);
      await sql`SELECT * FROM app.enter_workspace('alpha')`.execute(trx);
      return sql<{ email: string }>`SELECT email FROM users ORDER BY email`.execute(trx);
    });
    expect(r.rows.map((x) => x.email)).toEqual(["alice@a.example"]);
  });
});
