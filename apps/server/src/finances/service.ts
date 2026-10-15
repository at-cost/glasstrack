import { sql } from "kysely";
import { allocateCosts, dailyShare, GIB, recommendPrice, splitRevenue, usdToMicro } from "@glasstrack/shared";
import { currentPriceMicro } from "../billing/service";
import type { Deps } from "../context";
import { uuid7 } from "../lib/ids";
import { logger } from "../lib/logger";
import { fetchAwsCosts } from "./aws";

const n = (v: unknown) => Number(v ?? 0);
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (day: string, k: number) => isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + k * 86_400_000));

/** Public labels for cost categories. Manual entries can override with their own label. */
export const CATEGORY_LABELS: Record<string, string> = {
  infrastructure: "Servers and database",
  storage: "File storage",
  email: "Email delivery",
  domain: "Domain",
  tools: "Tools and services",
  ai: "AI usage",
  other: "Other",
};

/** Snapshot of active members (anyone active in the last 30 days) and storage per workspace. */
export async function snapshotUsage(deps: Deps, day: string): Promise<number> {
  const r = await sql`
    INSERT INTO usage_daily (workspace_id, day, active_members, storage_bytes)
    SELECT w.id, ${day}::date,
      (SELECT count(*) FROM workspace_members m WHERE m.workspace_id = w.id AND m.role <> 'viewer' AND m.last_active_at > ${day}::date + 1 - interval '30 days'),
      coalesce((SELECT sum(size_bytes) FROM attachments a WHERE a.workspace_id = w.id AND a.deleted_at IS NULL), 0)
        + coalesce((SELECT sum(size_bytes) FROM exports e WHERE e.workspace_id = w.id AND e.status = 'done'), 0)
    FROM workspaces w WHERE w.status != 'deleting'
    ON CONFLICT (workspace_id, day) DO UPDATE SET active_members = EXCLUDED.active_members, storage_bytes = EXCLUDED.storage_bytes`.execute(deps.dbs.system);
  return Number(r.numAffectedRows ?? 0);
}

/** Pulls the last few days from Cost Explorer; AWS revises recent days, so they are upserted. */
export async function importAwsCosts(deps: Deps, today = isoDay(new Date())): Promise<number> {
  if (!deps.config.AWS_COST_EXPLORER_ENABLED) return 0;
  const lines = await fetchAwsCosts(deps.config, addDays(today, -4), today);
  for (const l of lines) {
    await deps.dbs.system
      .insertInto("costEntries")
      .values({
        id: uuid7(), periodStart: l.day, periodEnd: l.day, category: l.category, source: "aws", amountMicro: l.amountMicro,
        publicLabel: CATEGORY_LABELS[l.category]!, note: l.service, externalKey: `aws:${l.day}:${l.service}`,
      })
      .onConflict((oc) => oc.column("externalKey").doUpdateSet({ amountMicro: l.amountMicro }))
      .execute();
  }
  return lines.length;
}

/**
 * Computes one day of public finances and the per-workspace cost allocation.
 * Recomputing a day replaces it, so late cost entries or AWS revisions flow in.
 */
export async function computeDay(deps: Deps, day: string): Promise<void> {
  const sys = deps.dbs.system;
  const cfg = deps.config;

  // Operating costs that day, by public label.
  const entries = await sys.selectFrom("costEntries").selectAll()
    .where("periodStart", "<=", day).where("periodEnd", ">=", day).execute();
  const costs: Record<string, number> = {};
  for (const e of entries) {
    const share = dailyShare(n(e.amountMicro), e.periodStart, e.periodEnd, day);
    if (share > 0) costs[e.publicLabel] = (costs[e.publicLabel] ?? 0) + share;
  }
  const operating = Object.values(costs).reduce((a, b) => a + b, 0);
  const storageCost = entries.filter((e) => e.category === "storage").reduce((a, e) => a + dailyShare(n(e.amountMicro), e.periodStart, e.periodEnd, day), 0);
  const emailCost = entries.filter((e) => e.category === "email").reduce((a, e) => a + dailyShare(n(e.amountMicro), e.periodStart, e.periodEnd, day), 0);

  // Payment fees that day, per workspace.
  const fees = await sys.selectFrom("payments").select(["workspaceId", sql<string>`coalesce(sum(fee_micro), 0)`.as("fee")])
    .where("status", "in", ["succeeded", "refunded"])
    .where(sql<string>`(succeeded_at AT TIME ZONE 'UTC')::date`, "=", day)
    .groupBy("workspaceId").execute();
  const feeByWs = new Map(fees.map((f) => [f.workspaceId, n(f.fee)]));
  const paymentFees = fees.reduce((a, f) => a + n(f.fee), 0);

  // Usage that day for workspaces that existed.
  const usage = await sys.selectFrom("usageDaily as u").innerJoin("workspaces as w", "w.id", "u.workspaceId")
    .select(["u.workspaceId", "u.activeMembers", "u.storageBytes", "u.emailsSent"]).where("u.day", "=", day).execute();
  const usageIds = new Set(usage.map((u) => u.workspaceId));
  const wsUsage = [
    ...usage.map((u) => ({ id: u.workspaceId, activeMembers: u.activeMembers, storageBytes: n(u.storageBytes), emails: u.emailsSent, paymentFeesMicro: feeByWs.get(u.workspaceId) ?? 0 })),
    // Fees of workspaces without a usage row (e.g. deleted since) still count.
    ...[...feeByWs.entries()].filter(([id]) => !usageIds.has(id)).map(([id, fee]) => ({ id, activeMembers: 0, storageBytes: 0, emails: 0, paymentFeesMicro: fee })),
  ];
  // Rates derived from what storage and email actually cost that day.
  const totalGb = wsUsage.reduce((a, w) => a + w.storageBytes / GIB, 0);
  const totalEmails = wsUsage.reduce((a, w) => a + w.emails, 0);
  const allocation = allocateCosts({
    operatingCostsMicro: operating,
    storageRatePerGbDayMicro: totalGb > 0 ? storageCost / totalGb : 0,
    emailRateMicro: totalEmails > 0 ? emailCost / totalEmails : usdToMicro(cfg.COST_EMAIL_USD),
    workspaces: wsUsage,
  });
  await sys.deleteFrom("workspaceCostDaily").where("day", "=", day).execute();
  const existing = new Set((await sys.selectFrom("workspaces").select("id").execute()).map((w) => w.id));
  const rows = allocation.filter((a) => existing.has(a.id));
  if (rows.length) {
    await sys.insertInto("workspaceCostDaily").values(rows.map((a) => ({
      workspaceId: a.id, day, sharedMicro: a.sharedMicro, storageMicro: a.storageMicro, emailMicro: a.emailMicro, feesMicro: a.feesMicro, totalMicro: a.totalMicro,
    }))).execute();
  }

  // Revenue: charges beyond each workspace's starter grant, recognised on the day charged.
  const perWs = await sql<{ workspaceId: string; starter: string; upto: string; before: string }>`
    SELECT workspace_id,
      coalesce(sum(amount_micro) FILTER (WHERE kind = 'starter_grant'), 0) AS starter,
      coalesce(-sum(amount_micro) FILTER (WHERE kind IN ('charge', 'storage_charge') AND ref_id <= ${day}), 0) AS upto,
      coalesce(-sum(amount_micro) FILTER (WHERE kind IN ('charge', 'storage_charge') AND ref_id < ${day}), 0) AS before
    FROM credit_ledger GROUP BY workspace_id`.execute(sys);
  let revenue = 0;
  let starterUsed = 0;
  let charged = 0;
  for (const r of perWs.rows) {
    const row = r;
    const a = splitRevenue(n(row.upto), n(row.starter));
    const b = splitRevenue(n(row.before), n(row.starter));
    revenue += a.revenueMicro - b.revenueMicro;
    starterUsed += a.starterUsedMicro - b.starterUsedMicro;
    if (n(row.upto) > n(row.before)) charged++;
  }
  // Paying workspaces: any recognised revenue in the 30 days to this day.
  const paying = await sql<{ n: string }>`
    SELECT count(*) AS n FROM (
      SELECT workspace_id,
        coalesce(sum(amount_micro) FILTER (WHERE kind = 'starter_grant'), 0) AS starter,
        coalesce(-sum(amount_micro) FILTER (WHERE kind IN ('charge', 'storage_charge') AND ref_id <= ${day}), 0) AS upto
      FROM credit_ledger GROUP BY workspace_id
    ) t WHERE upto > starter AND EXISTS (
      SELECT 1 FROM credit_ledger l WHERE l.workspace_id = t.workspace_id AND l.kind IN ('charge', 'storage_charge')
        AND l.ref_id > ${addDays(day, -30)} AND l.ref_id <= ${day})`.execute(sys);
  const payingWorkspaces = n(paying.rows[0]?.n);

  const totalCost = operating + paymentFees;
  // Reserve: everything recognised so far minus everything spent so far.
  const prior = await sys.selectFrom("financeDaily")
    .select([sql<string>`coalesce(sum(revenue_micro), 0)`.as("rev"), sql<string>`coalesce(sum(total_cost_micro), 0)`.as("cost")])
    .where("day", "<", day).executeTakeFirstOrThrow();
  const reserve = n(prior.rev) + revenue - (n(prior.cost) + totalCost);
  const last30 = await sys.selectFrom("financeDaily").select(sql<string>`coalesce(sum(total_cost_micro), 0)`.as("c"))
    .where("day", ">", addDays(day, -30)).where("day", "<", day).executeTakeFirstOrThrow();
  const daysKnown = Math.min(30, n((await sys.selectFrom("financeDaily").select((eb) => eb.fn.countAll<string>().as("k")).where("day", "<", day).executeTakeFirstOrThrow()).k) + 1);
  const monthlyCosts = Math.round(((n(last30.c) + totalCost) / daysKnown) * 30);
  const price = await currentPriceMicro(deps);
  const rec = recommendPrice({ monthlyCostsMicro: monthlyCosts, payingWorkspaces, reserveMicro: reserve, currentPriceMicro: price });
  const row = {
    day,
    revenueMicro: revenue,
    starterUsedMicro: starterUsed,
    costs: JSON.stringify(costs),
    paymentFeesMicro: paymentFees,
    totalCostMicro: totalCost,
    activeWorkspaces: charged,
    payingWorkspaces,
    costPerWorkspaceMicro: charged > 0 ? Math.round(totalCost / charged) : 0,
    reserveMicro: reserve,
    reserveTargetMicro: rec.reserveTargetMicro,
    priceMicro: price,
    recommendedPriceMicro: rec.recommendedMonthlyMicro,
    marginBp: rec.marginBp,
    computedAt: new Date(),
  };
  await sys.insertInto("financeDaily").values(row)
    .onConflict((oc) => oc.column("day").doUpdateSet({ ...row, day: undefined } as never)).execute();
}

/** Daily job: usage snapshot, AWS import, then recompute the last 3 days in order. */
export async function runDailyFinances(deps: Deps, now = new Date()): Promise<void> {
  if (!deps.config.BILLING_ENABLED) return;
  const today = isoDay(now);
  await snapshotUsage(deps, today);
  await importAwsCosts(deps, today).catch((err) => logger.error({ err }, "AWS cost import failed"));
  for (let k = 3; k >= 1; k--) await computeDay(deps, addDays(today, -k));
}

/** Recomputes a range in order (operator action after editing costs). */
export async function recompute(deps: Deps, from: string, to: string): Promise<number> {
  let k = 0;
  for (let d = from; d <= to && k < 400; d = addDays(d, 1), k++) await computeDay(deps, d);
  return k;
}
