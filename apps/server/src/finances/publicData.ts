import { activeWorkspaceIds, loadSettings, sharedFixedMonthMicro } from "../billing/pricing";
import type { Deps } from "../context";
import type { PublicCostLine, PublicFinances, PublicMonth, PublicPricing } from "./public";
import { addDays, computeDay, financesEnabled, isoDay } from "./service";

const n = (v: unknown) => Number(v ?? 0);

/**
 * Real figures from the finance tables. Returns null until real costs exist
 * (pages then show the labelled example), or when this server doesn't publish
 * finances. Aggregates only.
 */
export async function computePublic(deps: Deps, now = new Date()): Promise<{ pricing: PublicPricing; finances: PublicFinances } | null> {
  if (!financesEnabled(deps.config)) return null;
  const sys = deps.dbs.system;
  const anyCost = await sys.selectFrom("costEntries").select("id").limit(1).executeTakeFirst();
  if (!anyCost) return null;

  const today = isoDay(now);
  const month = today.slice(0, 7);
  // The hourly job keeps today current; compute it here if it hasn't run yet.
  const hasToday = await sys.selectFrom("financeDaily").select("day").where("day", "=", today).executeTakeFirst();
  if (!hasToday) await computeDay(deps, today);

  const settings = await loadSettings(sys);
  const sharedFixed = await sharedFixedMonthMicro(sys, today);
  const active = (await activeWorkspaceIds(sys, today)).size;
  const since = `${addDays(`${month}-01`, -730).slice(0, 7)}-01`;
  const rows = await sys.selectFrom("financeDaily").selectAll().where("day", ">=", since).where("day", "<=", today).orderBy("day").execute();
  const latest = rows.at(-1)!;

  const byMonth = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = r.day.slice(0, 7);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k)!.push(r);
  }
  const summarise = (k: string, rs: typeof rows): PublicMonth => {
    const last = rs.at(-1)!;
    const totalCost = rs.reduce((a, r) => a + n(r.totalCostMicro), 0);
    const activeMax = Math.max(0, ...rs.map((r) => r.activeWorkspaces));
    return {
      month: k,
      revenueMicro: rs.reduce((a, r) => a + n(r.revenueMicro), 0),
      totalCostMicro: totalCost,
      founderGapMicro: rs.reduce((a, r) => a + n(r.founderGapMicro), 0),
      reserveMicro: n(last.reserveMicro),
      activeWorkspaces: activeMax,
      payingWorkspaces: Math.max(0, ...rs.map((r) => r.payingWorkspaces)),
      costPerWorkspaceMicro: activeMax > 0 ? Math.round(totalCost / activeMax) : 0,
      serverShareCapMicro: n(last.serverShareCapMicro),
    };
  };
  const history = [...byMonth.entries()].map(([k, rs]) => summarise(k, rs)).slice(-24);
  const current = byMonth.get(month) ?? [latest];
  const costs = new Map<string, number>();
  const credits = new Set<string>();
  for (const r of current) {
    for (const [label, v] of Object.entries((r.costs ?? {}) as Record<string, number>)) costs.set(label, (costs.get(label) ?? 0) + n(v));
    for (const label of (r.costsPaidByCredits ?? []) as string[]) credits.add(label);
  }
  const costLines: PublicCostLine[] = [...costs.entries()].sort((a, b) => b[1] - a[1]).map(([label, amountMicro]) => ({ label, amountMicro, paidByCredits: credits.has(label) }));
  const thisMonth = summarise(month, current);

  const capRows = await sys.selectFrom("pricingSettings").select(["effectiveFrom", "serverShareCapUsd", "reason"]).orderBy("id").execute();
  const capHistory: PublicFinances["capHistory"] = [];
  for (const r of capRows) {
    const cap = Math.round(n(r.serverShareCapUsd) * 1_000_000);
    if (capHistory.at(-1)?.capMicro !== cap) capHistory.push({ from: r.effectiveFrom.toISOString(), capMicro: cap, reason: r.reason });
  }
  const savings = await sys.selectFrom("costSavings").select(["day", "change", "savingMonthMicro"]).orderBy("day", "desc").execute();
  const updatedAt = latest.computedAt.toISOString();

  return {
    pricing: { settings, sharedFixedMonthMicro: sharedFixed, activeWorkspaces: active, example: false, updatedAt },
    finances: {
      example: false,
      updatedAt,
      monthToDate: { from: current[0]!.day, to: current.at(-1)!.day },
      thisMonth: {
        ...thisMonth,
        costs: costLines,
        paymentFeesMicro: current.reduce((a, r) => a + n(r.paymentFeesMicro), 0),
        creditHeldMicro: n(latest.creditHeldMicro),
      },
      reserve: { balanceMicro: n(latest.reserveMicro), targetMicro: n(latest.reserveTargetMicro), targetMonths: settings.reserveTargetMonths },
      serverShareCapMicro: Math.round(settings.serverShareCapUsd * 1_000_000),
      recommendedCapMicro: latest.recommendedCapMicro === null ? null : n(latest.recommendedCapMicro),
      capHistory,
      history,
      savings: savings.map((s) => ({ date: s.day, change: s.change, savingMonthMicro: n(s.savingMonthMicro) })),
    },
  };
}
