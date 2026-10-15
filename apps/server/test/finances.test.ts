import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GIB, usdToMicro } from "@glasstrack/shared";
import { parseCostExplorer } from "../src/finances/aws";
import { clearPublicCache } from "../src/finances/public";
import { computeDay, runDailyFinances, snapshotUsage } from "../src/finances/service";
import { Client, createHarness, type Harness, setupWorkspace } from "./harness";

let h: Harness;
const D = "2026-03-10";

beforeAll(async () => {
  h = await createHarness({ BILLING_ENABLED: "true", OPERATOR_EMAILS: "ops@glasstrack.dev" });
});
beforeEach(async () => {
  await h.reset();
  clearPublicCache();
});
afterAll(async () => {
  await h?.close();
});

const wsId = async (c: Client, slug: string) => (await c.ok("GET", `/api/v1/w/${slug}`)).id as string;
const owner = () => h.deps.dbs.owner;

async function ledger(ws: string, kind: string, amount: number, key: string, refId: string | null = null) {
  await sql`INSERT INTO credit_ledger (workspace_id, kind, amount_micro, idempotency_key, ref_type, ref_id) VALUES (${ws}, ${kind}, ${amount}, ${key}, 'day', ${refId})`.execute(owner());
}

describe("metering", () => {
  it("counts API requests and emails per workspace and snapshots members and storage", async () => {
    const { c, team } = await setupWorkspace(h, "ann@acme.co", "acme");
    const id = await wsId(c, "acme");
    for (let i = 0; i < 5; i++) await c.ok("GET", "/api/v1/w/acme/issues");
    await c.ok("POST", "/api/v1/w/acme/invites", { email: "x@acme.co" });
    const issue = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "f" });
    await sql`INSERT INTO attachments (id, workspace_id, issue_id, storage_key, filename, content_type, size_bytes, uploaded_at)
      VALUES (gen_random_uuid(), ${id}, ${issue.id}, 'k', 'f', 'x', ${2 * GIB}, now())`.execute(owner());
    const today = new Date().toISOString().slice(0, 10);
    await h.deps.meter.flush(h.deps.dbs.system, today);
    await snapshotUsage(h.deps, today);
    const u = await h.deps.dbs.system.selectFrom("usageDaily").selectAll().where("workspaceId", "=", id).executeTakeFirstOrThrow();
    expect(u.apiRequests).toBeGreaterThanOrEqual(7);
    expect(u.emailsSent).toBe(1);
    expect(u.activeMembers).toBe(1);
    expect(Number(u.storageBytes)).toBe(2 * GIB);
  });
});

describe("daily finances", () => {
  async function scenario() {
    const a = await setupWorkspace(h, "ann@a.co", "alpha");
    const b = await setupWorkspace(h, "bob@b.co", "bravo");
    const A = await wsId(a.c, "alpha");
    const B = await wsId(b.c, "bravo");
    // $31 of servers over March = $1/day; $3.10 of storage = $0.10/day, paid by AWS credits.
    const ops = new Client(h);
    await ops.login("ops@glasstrack.dev");
    await ops.ok("POST", "/api/v1/admin/costs", { periodStart: "2026-03-01", periodEnd: "2026-03-31", category: "infrastructure", amountUsd: 31 });
    await ops.ok("POST", "/api/v1/admin/costs", { periodStart: "2026-03-01", periodEnd: "2026-03-31", category: "storage", amountUsd: 3.1, paidByCredits: true });
    // Alpha used its $10 signup credit before D and pays $0.30 on D; bravo's $0.30 on D is signup credit.
    for (let k = 0; k < 10; k++) await ledger(A, "charge", -usdToMicro(1), `a${k}`, `2026-02-${String(10 + k)}`);
    await ledger(A, "charge", -usdToMicro(0.3), "a-D", D);
    await ledger(B, "charge", -usdToMicro(0.3), "b-D", D);
    // Alpha tops up $25 on D; Stripe keeps $0.88.
    await sql`INSERT INTO payments (id, workspace_id, kind, amount_micro, fee_micro, status, succeeded_at)
      VALUES (gen_random_uuid(), ${A}, 'topup', 25000000, 880000, 'succeeded', ${`${D}T12:00:00Z`})`.execute(owner());
    await sql`INSERT INTO credit_ledger (workspace_id, kind, amount_micro, idempotency_key, created_at) VALUES (${A}, 'topup', 25000000, 'top-D', ${`${D}T12:00:00Z`})`.execute(owner());
    return { A, B, ops };
  }

  it("revenue is credit used; credit held is not income; the founder covers the gap; only surpluses build the reserve", async () => {
    await scenario();
    await computeDay(h.deps, D);
    const f = await h.deps.dbs.system.selectFrom("financeDaily").selectAll().where("day", "=", D).executeTakeFirstOrThrow();
    expect(f.costs).toEqual({ "Servers and database": usdToMicro(1), "File storage": usdToMicro(0.1) });
    expect(f.costsPaidByCredits).toEqual(["File storage"]);
    expect(Number(f.paymentFeesMicro)).toBe(880_000);
    expect(Number(f.totalCostMicro)).toBe(usdToMicro(1.1) + 880_000);
    expect(Number(f.revenueMicro)).toBe(usdToMicro(0.3)); // alpha's paid usage
    expect(Number(f.starterUsedMicro)).toBe(usdToMicro(0.3)); // bravo's signup credit
    expect(Number(f.creditHeldMicro)).toBe(usdToMicro(24.7)); // $25 paid in, $0.30 used
    expect(Number(f.founderGapMicro)).toBe(usdToMicro(1.1) + 880_000 - usdToMicro(0.3));
    expect(Number(f.reserveMicro)).toBe(0);
    expect(f.activeWorkspaces).toBe(2);
    expect(f.payingWorkspaces).toBe(1);
    expect(Number(f.sharedFixedMicro)).toBe(usdToMicro(31)); // servers only: storage is charged per workspace
    expect(Number(f.serverShareCapMicro)).toBe(usdToMicro(5));
    expect(f.recommendedCapMicro).toBeNull();

    // The next day alpha uses $5: a $3.90 surplus goes to the reserve; nothing for the founder to cover.
    const next = "2026-03-11";
    const { A } = { A: await h.deps.dbs.system.selectFrom("workspaces").select("id").where("slug", "=", "alpha").executeTakeFirstOrThrow().then((r) => r.id) };
    await ledger(A, "charge", -usdToMicro(5), "a-next", next);
    await computeDay(h.deps, next);
    const g = await h.deps.dbs.system.selectFrom("financeDaily").selectAll().where("day", "=", next).executeTakeFirstOrThrow();
    expect(Number(g.reserveMicro)).toBe(usdToMicro(3.9));
    expect(Number(g.founderGapMicro)).toBe(0);
    expect(Number(g.creditHeldMicro)).toBe(usdToMicro(19.7));
  });

  it("recomputing a day is stable and reflects edited costs", async () => {
    const { ops } = await scenario();
    await computeDay(h.deps, D);
    await computeDay(h.deps, D);
    expect((await h.deps.dbs.system.selectFrom("financeDaily").selectAll().execute()).length).toBe(1);
    await ops.ok("POST", "/api/v1/admin/costs", { periodStart: D, periodEnd: D, category: "domain", amountUsd: 12, publicLabel: "Domain (glasstrack.dev)" });
    await ops.ok("POST", "/api/v1/admin/finances/recompute", { from: D, to: D });
    const f = await h.deps.dbs.system.selectFrom("financeDaily").selectAll().where("day", "=", D).executeTakeFirstOrThrow();
    expect(f.costs).toMatchObject({ "Domain (glasstrack.dev)": usdToMicro(12) });
  });

  it("the daily job snapshots usage and computes the last 3 days and today", async () => {
    await setupWorkspace(h, "ann@acme.co", "acme");
    await runDailyFinances(h.deps);
    const days = await h.deps.dbs.system.selectFrom("financeDaily").select("day").orderBy("day").execute();
    expect(days).toHaveLength(4);
    expect((await h.deps.dbs.system.selectFrom("usageDaily").selectAll().execute()).length).toBe(1);
  });
});

describe("public finances", () => {
  it("shows the labelled example until real costs exist, then real aggregates only", async () => {
    const anon = new Client(h);
    expect((await anon.ok("GET", "/api/v1/public/finances")).example).toBe(true);
    expect((await anon.ok("GET", "/api/v1/public/pricing")).example).toBe(true);
    clearPublicCache();

    const a = await setupWorkspace(h, "ann@secretco.co", "secret-project-x");
    const A = await wsId(a.c, "secret-project-x");
    const ops = await new Client(h).login("ops@glasstrack.dev");
    const today = new Date().toISOString().slice(0, 10);
    await ops.ok("POST", "/api/v1/admin/costs", { periodStart: `${today.slice(0, 7)}-01`, periodEnd: today, category: "infrastructure", amountUsd: 40, publicLabel: "Servers (AWS EC2)", paidByCredits: true });
    await ledger(A, "charge", -usdToMicro(0.2), "x", today);
    await ops.ok("POST", "/api/v1/admin/savings", { day: today, change: "Moved backups to a cheaper storage class", savingMonthUsd: 1.5 });
    clearPublicCache();
    const r = await anon.req("GET", "/api/v1/public/finances");
    expect(r.status).toBe(200);
    expect(r.body.example).toBe(false);
    expect(r.body.thisMonth.costs).toEqual([{ label: "Servers (AWS EC2)", amountMicro: expect.any(Number), paidByCredits: true }]);
    expect(r.body.savings).toEqual([{ date: today, change: "Moved backups to a cheaper storage class", savingMonthMicro: usdToMicro(1.5) }]);
    expect(r.body.monthToDate.to).toBe(today);
    const text = JSON.stringify(r.body);
    for (const secret of [A, "secret-project-x", "SECRET-PROJECT-X", "secretco", "ann@"]) expect(text).not.toContain(secret);
    const pricing = await anon.ok("GET", "/api/v1/public/pricing");
    expect(pricing).toMatchObject({ example: false, activeWorkspaces: 1, settings: { serverShareCapUsd: 5 } });
    const csv = await anon.req("GET", "/api/v1/public/finances.csv");
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(String(csv.body)).toContain("month,revenue_usd");
    expect(String(csv.body)).not.toContain(A);
  });

  it("is not published by self-hosted servers, unless FINANCES_PUBLIC is on (costs before billing)", async () => {
    const off = await createHarness();
    try {
      expect((await new Client(off).get("/api/v1/public/finances")).status).toBe(404);
    } finally {
      await off.close();
    }
    const pub = await createHarness({ FINANCES_PUBLIC: "true" });
    try {
      expect((await new Client(pub).get("/api/v1/public/finances")).status).toBe(200);
    } finally {
      await pub.close();
    }
  });
});

describe("operator admin", () => {
  it("is operators only", async () => {
    const { c } = await setupWorkspace(h, "ann@acme.co", "acme");
    expect((await c.get("/api/v1/admin/overview")).status).toBe(403);
    expect((await c.post("/api/v1/admin/pricing", { serverShareCapUsd: 1, reason: "test" })).status).toBe(403);
    expect((await new Client(h).get("/api/v1/admin/overview")).status).toBe(401);
    expect((await c.ok("GET", "/api/v1/admin/me")).operator).toBe(false);
  });

  it("can change pricing settings, but the server share cap only ever goes down", async () => {
    const ops = await new Client(h).login("ops@glasstrack.dev");
    expect((await ops.ok("GET", "/api/v1/admin/me")).operator).toBe(true);
    expect((await ops.post("/api/v1/admin/pricing", { serverShareCapUsd: 6, reason: "raise" })).status).toBe(400);
    expect((await ops.post("/api/v1/admin/pricing", { minTopupUsd: 600, reason: "bad" })).status).toBe(400);
    const s = await ops.ok("POST", "/api/v1/admin/pricing", { serverShareCapUsd: 4.5, emailUsdPer1000: 0.09, reason: "Costs fell" });
    expect(s).toMatchObject({ serverShareCapUsd: 4.5, emailUsdPer1000: 0.09, minTopupUsd: 10 });
    const o = await ops.ok("GET", "/api/v1/admin/overview");
    expect(o.settings.serverShareCapUsd).toBe(4.5);
    expect(o.settingsHistory.map((p: { serverShareCapUsd: number }) => p.serverShareCapUsd)).toEqual([4.5, 5]);
  });

  it("validates cost entries and only edits manual ones", async () => {
    const ops = await new Client(h).login("ops@glasstrack.dev");
    expect((await ops.post("/api/v1/admin/costs", { periodStart: "2026-03-05", periodEnd: "2026-03-01", category: "tools", amountUsd: 5 })).status).toBe(400);
    const { id } = await ops.ok("POST", "/api/v1/admin/costs", { periodStart: "2026-03-01", periodEnd: "2026-03-31", category: "ai", amountUsd: 20, note: "LLM API" });
    await ops.ok("PATCH", `/api/v1/admin/costs/${id}`, { periodStart: "2026-03-01", periodEnd: "2026-03-31", category: "ai", amountUsd: 25 });
    await sql`INSERT INTO cost_entries (id, period_start, period_end, category, source, amount_micro, public_label, external_key)
      VALUES (gen_random_uuid(), '2026-03-01', '2026-03-01', 'infrastructure', 'aws', 1, 'x', 'aws:x')`.execute(owner());
    const aws = (await ops.ok("GET", "/api/v1/admin/overview")).costs.find((c: { source: string }) => c.source === "aws");
    expect((await ops.del(`/api/v1/admin/costs/${aws.id}`)).status).toBe(404);
    await ops.ok("DELETE", `/api/v1/admin/costs/${id}`);
  });
});

describe("AWS Cost Explorer parsing", () => {
  it("maps services to categories and skips zero and non-USD lines", () => {
    const lines = parseCostExplorer({
      ResultsByTime: [{
        TimePeriod: { Start: "2026-03-09" },
        Groups: [
          { Keys: ["Amazon Elastic Compute Cloud - Compute"], Metrics: { UnblendedCost: { Amount: "1.2345", Unit: "USD" } } },
          { Keys: ["Amazon Simple Storage Service"], Metrics: { UnblendedCost: { Amount: "0.05", Unit: "USD" } } },
          { Keys: ["Amazon Simple Email Service"], Metrics: { UnblendedCost: { Amount: "0.01", Unit: "USD" } } },
          { Keys: ["Tax"], Metrics: { UnblendedCost: { Amount: "0", Unit: "USD" } } },
          { Keys: ["Odd"], Metrics: { UnblendedCost: { Amount: "3", Unit: "EUR" } } },
        ],
      }],
    });
    expect(lines).toEqual([
      { day: "2026-03-09", service: "Amazon Elastic Compute Cloud - Compute", amountMicro: 1_234_500, category: "infrastructure" },
      { day: "2026-03-09", service: "Amazon Simple Storage Service", amountMicro: 50_000, category: "storage" },
      { day: "2026-03-09", service: "Amazon Simple Email Service", amountMicro: 10_000, category: "email" },
    ]);
  });
});
