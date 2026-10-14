import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dailyCharge, GIB, usdToMicro } from "@glasstrack/shared";
import { parseCostExplorer } from "../src/finances/aws";
import { computeDay, runDailyFinances, snapshotUsage } from "../src/finances/service";
import { Client, createHarness, type Harness, setupWorkspace } from "./harness";

let h: Harness;
const D = "2026-03-10";

beforeAll(async () => {
  h = await createHarness({ BILLING_ENABLED: "true", OPERATOR_EMAILS: "ops@glasstrack.dev" });
});
beforeEach(async () => {
  await h.reset();
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
    // Alpha: 3 active members, 1 GB, 100 emails; bravo: 1 member.
    await sql`INSERT INTO usage_daily (workspace_id, day, active_members, storage_bytes, emails_sent) VALUES
      (${A}, ${D}, 3, ${GIB}, 100), (${B}, ${D}, 1, 0, 0)`.execute(owner());
    // $31 of servers over March = $1/day; $3.10 of storage = $0.10/day.
    const ops = new Client(h);
    await ops.login("ops@glasstrack.dev");
    await ops.ok("POST", "/api/v1/admin/costs", { periodStart: "2026-03-01", periodEnd: "2026-03-31", category: "infrastructure", amountUsd: 31 });
    await ops.ok("POST", "/api/v1/admin/costs", { periodStart: "2026-03-01", periodEnd: "2026-03-31", category: "storage", amountUsd: 3.1 });
    // Alpha has used all its starter credit before D and is paying; bravo is still on starter credit.
    const day = dailyCharge(usdToMicro(10));
    for (let k = 0; k < 31; k++) await ledger(A, "charge", -day, `a${k}`, `2026-02-${String(7 + (k % 22)).padStart(2, "0")}-${k}`);
    await ledger(A, "charge", -day, "a-D", D);
    await ledger(B, "charge", -day, "b-D", D);
    // A top-up on D with a $0.88 fee.
    await sql`INSERT INTO payments (id, workspace_id, kind, amount_micro, fee_micro, status, succeeded_at)
      VALUES (gen_random_uuid(), ${A}, 'topup', 25000000, 880000, 'succeeded', ${`${D}T12:00:00Z`})`.execute(owner());
    return { A, B, ops, day };
  }

  it("rolls up revenue, every cost line, allocation and the reserve", async () => {
    const { A, B, day } = await scenario();
    await computeDay(h.deps, D);
    const f = await h.deps.dbs.system.selectFrom("financeDaily").selectAll().where("day", "=", D).executeTakeFirstOrThrow();
    expect(f.costs).toEqual({ "Servers and database": usdToMicro(1), "File storage": usdToMicro(0.1) });
    expect(Number(f.paymentFeesMicro)).toBe(880_000);
    expect(Number(f.totalCostMicro)).toBe(usdToMicro(1.1) + 880_000);
    // Alpha's charge on D is past its $10 starter grant, so it is revenue; bravo's is starter credit.
    expect(Number(f.revenueMicro)).toBe(day);
    expect(Number(f.starterUsedMicro)).toBe(day);
    expect(f.activeWorkspaces).toBe(2);
    expect(f.payingWorkspaces).toBe(1);
    expect(Number(f.reserveMicro)).toBe(day - (usdToMicro(1.1) + 880_000));

    const alloc = await h.deps.dbs.system.selectFrom("workspaceCostDaily").selectAll().where("day", "=", D).execute();
    const sum = alloc.reduce((s, r) => s + Number(r.totalMicro), 0);
    expect(sum).toBe(Number(f.totalCostMicro));
    const a = alloc.find((r) => r.workspaceId === A)!;
    const b = alloc.find((r) => r.workspaceId === B)!;
    expect(Number(a.storageMicro)).toBe(usdToMicro(0.1)); // all stored bytes are alpha's
    expect(Number(a.feesMicro)).toBe(880_000);
    expect(Number(a.sharedMicro)).toBeGreaterThan(Number(b.sharedMicro) * 2); // 3 members vs 1
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

  it("the daily job fills usage and allocation rows", async () => {
    await setupWorkspace(h, "ann@acme.co", "acme");
    await runDailyFinances(h.deps);
    const days = await h.deps.dbs.system.selectFrom("financeDaily").select("day").orderBy("day").execute();
    expect(days).toHaveLength(3);
    expect((await h.deps.dbs.system.selectFrom("usageDaily").selectAll().execute()).length).toBe(1);
  });
});

describe("public finances", () => {
  it("publishes aggregates only, never anything that identifies a workspace", async () => {
    const a = await setupWorkspace(h, "ann@secretco.co", "secret-project-x");
    const A = await wsId(a.c, "secret-project-x");
    await sql`INSERT INTO usage_daily (workspace_id, day, active_members) VALUES (${A}, ${D}, 2)`.execute(owner());
    await ledger(A, "charge", -dailyCharge(usdToMicro(10)), "x", D);
    await computeDay(h.deps, D);
    const anon = new Client(h);
    const r = await anon.req("GET", "/api/v1/public/finances?days=3650");
    expect(r.status).toBe(200);
    const text = JSON.stringify(r.body);
    for (const secret of [A, "secret-project-x", "SECRET-PROJECT-X", "secretco", "ann@"]) expect(text).not.toContain(secret);
    expect(r.body.history).toHaveLength(1);
    expect(r.body.formula.price).toContain("never raised");
    const csv = await anon.req("GET", "/api/v1/public/finances.csv");
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(String(csv.body)).toContain("day,revenue_usd");
    expect(String(csv.body)).not.toContain(A);
  });

  it("is not published by self-hosted servers", async () => {
    const off = await createHarness();
    try {
      expect((await new Client(off).get("/api/v1/public/finances")).status).toBe(404);
    } finally {
      await off.close();
    }
  });
});

describe("operator admin", () => {
  it("is operators only", async () => {
    const { c } = await setupWorkspace(h, "ann@acme.co", "acme");
    expect((await c.get("/api/v1/admin/overview")).status).toBe(403);
    expect((await c.post("/api/v1/admin/pricing/lower", { monthlyUsd: 1, reason: "test" })).status).toBe(403);
    expect((await new Client(h).get("/api/v1/admin/overview")).status).toBe(401);
    expect((await c.ok("GET", "/api/v1/admin/me")).operator).toBe(false);
  });

  it("can lower the price but never raise it", async () => {
    const ops = await new Client(h).login("ops@glasstrack.dev");
    expect((await ops.ok("GET", "/api/v1/admin/me")).operator).toBe(true);
    expect((await ops.post("/api/v1/admin/pricing/lower", { monthlyUsd: 12, reason: "raise" })).status).toBe(400);
    expect((await ops.post("/api/v1/admin/pricing/lower", { monthlyUsd: 10, reason: "same" })).status).toBe(400);
    await ops.ok("POST", "/api/v1/admin/pricing/lower", { monthlyUsd: 8.5, reason: "Costs fell" });
    const o = await ops.ok("GET", "/api/v1/admin/overview");
    expect(o.currentPriceMicro).toBe(usdToMicro(8.5));
    expect(o.pricing.map((p: { monthlyPriceMicro: number }) => p.monthlyPriceMicro)).toEqual([usdToMicro(8.5), usdToMicro(10)]);
    const pub = await new Client(h).ok("GET", "/api/v1/public/finances");
    expect(pub.priceHistory.at(-1)).toMatchObject({ monthlyPriceMicro: usdToMicro(8.5), reason: "Costs fell" });
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
