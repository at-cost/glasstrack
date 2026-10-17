import { sql } from "kysely";
import { dailyShare, recommendCap, splitRevenue, usdToMicro } from "@glasstrack/shared";
import { activeWorkspaceIds, loadSettings, sharedFixedMonthMicro } from "../billing/pricing";
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

/** Public labels for imported AWS lines. */
const AWS_LABELS: Record<string, string> = {
  infrastructure: "Servers, disk and network (AWS)",
  storage: "Backups and file storage (AWS S3)",
  email: "Email delivery (AWS SES)",
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
  // AWS revises recent days for a while, so look back a week.
  const lines = await fetchAwsCosts(deps.config, addDays(today, -7), today);
  for (const l of lines) {
    await deps.dbs.system
      .insertInto("costEntries")
      .values({
        id: uuid7(), periodStart: l.day, periodEnd: l.day, category: l.category, source: "aws", amountMicro: l.amountMicro,
        publicLabel: AWS_LABELS[l.category]!, note: l.service, externalKey: `aws:${l.day}:${l.service}`, paidByCredits: l.paidByCredits,
      })
      .onConflict((oc) => oc.column("externalKey").doUpdateSet({ amountMicro: l.amountMicro, paidByCredits: l.paidByCredits }))
      .execute();
  }
  return lines.length;
}

/**
 * Computes one day of public finances. Recomputing a day replaces it, so late
 * cost entries or AWS revisions flow in. Aggregates only, never per workspace.
 *
 * revenue       = credit actually used that day (charges beyond the signup credit)
 * credit held   = unused prepaid (paid) balances at the end of the day: not income
 * founder gap   = costs + payment fees − revenue, when positive (the owner covers it)
 * reserve       = running total of daily surpluses (revenue − costs, when positive)
 */
export async function computeDay(deps: Deps, day: string): Promise<void> {
  const sys = deps.dbs.system;
  const settings = await loadSettings(sys);

  // Operating costs that day, by public label.
  const entries = await sys.selectFrom("costEntries").selectAll()
    .where("periodStart", "<=", day).where("periodEnd", ">=", day).execute();
  const costs: Record<string, number> = {};
  const byCredits = new Set<string>();
  for (const e of entries) {
    const share = dailyShare(n(e.amountMicro), e.periodStart, e.periodEnd, day);
    if (share > 0) costs[e.publicLabel] = (costs[e.publicLabel] ?? 0) + share;
    if (e.paidByCredits) byCredits.add(e.publicLabel);
  }
  const operating = Object.values(costs).reduce((a, b) => a + b, 0);

  // Payment fees that day.
  const fees = await sys.selectFrom("payments").select(sql<string>`coalesce(sum(fee_micro), 0)`.as("fee"))
    .where("status", "in", ["succeeded", "refunded"])
    .where(sql<string>`(succeeded_at AT TIME ZONE 'UTC')::date`, "=", day).executeTakeFirstOrThrow();
  const paymentFees = n(fees.fee);

  // Revenue: charges beyond each workspace's signup credit, recognised on the day charged.
  const perWs = await sql<{ starter: string; upto: string; before: string; paid: string }>`
    SELECT
      coalesce(sum(amount_micro) FILTER (WHERE kind = 'starter_grant'), 0) AS starter,
      coalesce(-sum(amount_micro) FILTER (WHERE kind IN ('charge', 'storage_charge') AND ref_id <= ${day}), 0) AS upto,
      coalesce(-sum(amount_micro) FILTER (WHERE kind IN ('charge', 'storage_charge') AND ref_id < ${day}), 0) AS before,
      coalesce(sum(amount_micro) FILTER (WHERE kind IN ('topup', 'refund', 'adjustment') AND (created_at AT TIME ZONE 'UTC')::date <= ${day}), 0) AS paid
    FROM credit_ledger GROUP BY workspace_id`.execute(sys);
  let revenue = 0;
  let starterUsed = 0;
  let creditHeld = 0;
  for (const r of perWs.rows) {
    const a = splitRevenue(n(r.upto), n(r.starter));
    const b = splitRevenue(n(r.before), n(r.starter));
    revenue += a.revenueMicro - b.revenueMicro;
    starterUsed += a.starterUsedMicro - b.starterUsedMicro;
    // Paid money not yet used: what was paid in (net of refunds) minus paid usage so far.
    creditHeld += Math.max(0, n(r.paid) - a.revenueMicro);
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
  const active = (await activeWorkspaceIds(sys, day)).size;

  const totalCost = operating + paymentFees;
  const gap = Math.max(0, totalCost - revenue);
  const prior = await sys.selectFrom("financeDaily").select("reserveMicro").where("day", "<", day).orderBy("day", "desc").limit(1).executeTakeFirst();
  const reserve = n(prior?.reserveMicro) + Math.max(0, revenue - totalCost);
  // Monthly costs: the last 30 days (fewer if history is shorter), scaled to 30 days.
  const last30 = await sys.selectFrom("financeDaily").select([sql<string>`coalesce(sum(total_cost_micro), 0)`.as("c"), sql<string>`count(*)`.as("k")])
    .where("day", ">", addDays(day, -30)).where("day", "<", day).executeTakeFirstOrThrow();
  const monthlyCosts = Math.round(((n(last30.c) + totalCost) / (n(last30.k) + 1)) * 30);
  const sharedFixed = await sharedFixedMonthMicro(sys, day);
  const rec = recommendCap({ settings, reserveMicro: reserve, monthlyCostsMicro: monthlyCosts, sharedFixedMonthMicro: sharedFixed, activeWorkspaces: active });
  const row = {
    day,
    revenueMicro: revenue,
    starterUsedMicro: starterUsed,
    costs: JSON.stringify(costs),
    costsPaidByCredits: JSON.stringify([...byCredits].sort()),
    paymentFeesMicro: paymentFees,
    totalCostMicro: totalCost,
    activeWorkspaces: active,
    payingWorkspaces,
    costPerWorkspaceMicro: active > 0 ? Math.round(totalCost / active) : 0,
    reserveMicro: reserve,
    reserveTargetMicro: rec.reserveTargetMicro,
    priceMicro: 0,
    recommendedPriceMicro: null,
    sharedFixedMicro: sharedFixed,
    creditHeldMicro: creditHeld,
    founderGapMicro: gap,
    serverShareCapMicro: usdToMicro(settings.serverShareCapUsd),
    recommendedCapMicro: rec.recommendedCapMicro,
    computedAt: new Date(),
  };
  await sys.insertInto("financeDaily").values(row)
    .onConflict((oc) => oc.column("day").doUpdateSet({ ...row, day: undefined } as never)).execute();
}

/** Finances are published when billing is on, or on their own with FINANCES_PUBLIC (costs before revenue). */
export const financesEnabled = (cfg: Deps["config"]) => cfg.BILLING_ENABLED || cfg.FINANCES_PUBLIC;

/** Daily job: usage snapshot, AWS import, then recompute the last 3 days in order. */
export async function runDailyFinances(deps: Deps, now = new Date()): Promise<void> {
  if (!financesEnabled(deps.config)) return;
  const today = isoDay(now);
  await snapshotUsage(deps, today);
  await importAwsCosts(deps, today).catch((err) => logger.error({ err }, "AWS cost import failed"));
  for (let k = 3; k >= 0; k--) await computeDay(deps, addDays(today, -k));
}

/** Recomputes a range in order (operator action after editing costs). */
export async function recompute(deps: Deps, from: string, to: string): Promise<number> {
  let k = 0;
  for (let d = from; d <= to && k < 400; d = addDays(d, 1), k++) await computeDay(deps, d);
  return k;
}
