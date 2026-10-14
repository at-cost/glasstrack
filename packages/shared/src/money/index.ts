/**
 * Money maths for billing and public finances. Pure functions, no I/O.
 * All amounts are integer micro-USD (1 USD = 1,000,000) so daily pro-rata
 * charges are exact; convert to cents only for Stripe.
 */

export const MICRO = 1_000_000;
export const GIB = 1024 ** 3;
const DAYS_PER_YEAR = 365;

export const usdToMicro = (usd: number): number => Math.round(usd * MICRO);
export const microToCents = (micro: number): number => Math.round(micro / 10_000);
export const centsToMicro = (cents: number): number => cents * 10_000;

export function formatUsd(micro: number, opts: { precise?: boolean } = {}): string {
  const dollars = micro / MICRO;
  const digits = opts.precise && Math.abs(micro) % 10_000 !== 0 ? 4 : 2;
  return `${dollars < 0 ? "-" : ""}$${Math.abs(dollars).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** Flat monthly price charged daily: the same amount every day, 12 months a year. */
export function dailyCharge(monthlyPriceMicro: number): number {
  return Math.round((monthlyPriceMicro * 12) / DAYS_PER_YEAR);
}

/** Storage above the free allowance, billed daily at cost per GB-month. */
export function storageOverageDaily(storageBytes: number, freeGb: number, ratePerGbMonthMicro: number): number {
  const excessGb = Math.max(0, storageBytes / GIB - freeGb);
  return Math.round((excessGb * ratePerGbMonthMicro * 12) / DAYS_PER_YEAR);
}

export type BillingStatus = "active" | "grace" | "read_only";
export const GRACE_DAYS = 7;
/** Warning emails go out on these grace days (0 = the day the balance ran out). */
export const GRACE_WARNING_DAYS = [0, 3, 6] as const;

export interface BillingState {
  status: BillingStatus;
  balanceMicro: number;
  graceStartedAt: Date | null;
  warningsSent: number;
}

export interface BillingTransition {
  status: BillingStatus;
  graceStartedAt: Date | null;
  warningsSent: number;
  /** Email to send, if any. */
  email: null | { kind: "grace_warning"; day: number; daysLeft: number } | { kind: "read_only" } | { kind: "restored" };
}

/**
 * Balance-driven status. Positive balance: active. Zero or below: a 7-day
 * grace period with warnings, then read-only. Data is never deleted.
 */
export function nextBillingState(s: BillingState, now: Date): BillingTransition {
  if (s.balanceMicro > 0) {
    return {
      status: "active",
      graceStartedAt: null,
      warningsSent: 0,
      email: s.status === "active" ? null : { kind: "restored" },
    };
  }
  if (s.status === "read_only") return { status: "read_only", graceStartedAt: s.graceStartedAt, warningsSent: s.warningsSent, email: null };
  const started = s.status === "grace" && s.graceStartedAt ? s.graceStartedAt : now;
  const day = Math.floor((now.getTime() - started.getTime()) / 86_400_000);
  if (day >= GRACE_DAYS) return { status: "read_only", graceStartedAt: started, warningsSent: s.warningsSent, email: { kind: "read_only" } };
  const due = GRACE_WARNING_DAYS.filter((d) => d <= day).length;
  const sentBefore = s.status === "grace" ? s.warningsSent : 0;
  return {
    status: "grace",
    graceStartedAt: started,
    warningsSent: Math.max(due, sentBefore),
    email: due > sentBefore ? { kind: "grace_warning", day, daysLeft: GRACE_DAYS - day } : null,
  };
}

/** Never let a new price exceed the current one. */
export function assertPriceNotIncreased(currentMicro: number | null, nextMicro: number): void {
  if (currentMicro !== null && nextMicro > currentMicro) {
    throw new Error(`Price can only go down: ${formatUsd(nextMicro)} > ${formatUsd(currentMicro)}`);
  }
  if (nextMicro < 0) throw new Error("Price can't be negative");
}

/**
 * Splits `total` into integer parts proportional to `weights`, assigning the
 * rounding remainder by largest fractional part so the parts sum exactly to
 * total. Zero total weight splits evenly.
 */
export function distribute(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  if (!Number.isInteger(total)) throw new Error("distribute: total must be an integer");
  const sum = weights.reduce((a, b) => a + b, 0);
  const w = sum > 0 ? weights : weights.map(() => 1);
  const wsum = sum > 0 ? sum : weights.length;
  const raw = w.map((x) => (total * x) / wsum);
  const parts = raw.map(Math.floor);
  let rest = total - parts.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) parts[order[k]!.i]! += 1;
  return parts;
}

export interface WorkspaceUsage {
  id: string;
  activeMembers: number;
  storageBytes: number;
  emails: number;
  paymentFeesMicro: number;
}

export interface AllocationInput {
  /** Every cost for the period except payment fees (infrastructure, tools, domain...). */
  operatingCostsMicro: number;
  storageRatePerGbDayMicro: number;
  emailRateMicro: number;
  workspaces: WorkspaceUsage[];
}

export interface WorkspaceCost {
  id: string;
  sharedMicro: number;
  storageMicro: number;
  emailMicro: number;
  feesMicro: number;
  totalMicro: number;
}

/**
 * workspace_cost = shared × (its active members / all active members)
 *                + storage_GB × storage_rate + emails × email_rate + its payment fees
 *
 * Storage and email are part of the operating bill, so they are carved out of
 * it first: shared = operating − direct storage − direct email. If direct
 * usage would exceed the bill, it is scaled down so nothing is double counted.
 * Sum of totals always equals operating costs + payment fees, exactly.
 */
export function allocateCosts(input: AllocationInput): WorkspaceCost[] {
  const ws = input.workspaces;
  if (ws.length === 0) return [];
  let storage = ws.map((w) => Math.round((w.storageBytes / GIB) * input.storageRatePerGbDayMicro));
  let email = ws.map((w) => Math.round(w.emails * input.emailRateMicro));
  const direct = storage.reduce((a, b) => a + b, 0) + email.reduce((a, b) => a + b, 0);
  if (direct > input.operatingCostsMicro) {
    const scaled = distribute(input.operatingCostsMicro, [...storage, ...email]);
    storage = scaled.slice(0, ws.length);
    email = scaled.slice(ws.length);
  }
  const shared = input.operatingCostsMicro - storage.reduce((a, b) => a + b, 0) - email.reduce((a, b) => a + b, 0);
  const sharedParts = distribute(shared, ws.map((w) => w.activeMembers));
  return ws.map((w, i) => {
    const parts = { sharedMicro: sharedParts[i]!, storageMicro: storage[i]!, emailMicro: email[i]!, feesMicro: w.paymentFeesMicro };
    return { id: w.id, ...parts, totalMicro: parts.sharedMicro + parts.storageMicro + parts.emailMicro + parts.feesMicro };
  });
}

export const MARGIN_BUILDING_RESERVE = 0.1;
export const MARGIN_RESERVE_FULL = 0.02;
export const RESERVE_TARGET_MONTHS = 6;

export interface PriceRecommendation {
  marginBp: number;
  reserveTargetMicro: number;
  recommendedMonthlyMicro: number | null;
  /** True when the recommendation is below the current price. */
  canLower: boolean;
}

/**
 * recommended = (monthly costs ÷ paying workspaces) × (1 + margin)
 * margin = 10% until the reserve covers 6 months of costs, then 2%.
 * Rounded up to the next cent so the price always covers cost.
 */
export function recommendPrice(p: {
  monthlyCostsMicro: number;
  payingWorkspaces: number;
  reserveMicro: number;
  currentPriceMicro: number;
}): PriceRecommendation {
  const reserveTargetMicro = RESERVE_TARGET_MONTHS * p.monthlyCostsMicro;
  const margin = p.reserveMicro >= reserveTargetMicro && p.monthlyCostsMicro > 0 ? MARGIN_RESERVE_FULL : MARGIN_BUILDING_RESERVE;
  if (p.payingWorkspaces <= 0) {
    return { marginBp: Math.round(margin * 10_000), reserveTargetMicro, recommendedMonthlyMicro: null, canLower: false };
  }
  const raw = (p.monthlyCostsMicro / p.payingWorkspaces) * (1 + margin);
  const recommended = Math.ceil(raw / 10_000) * 10_000;
  return {
    marginBp: Math.round(margin * 10_000),
    reserveTargetMicro,
    recommendedMonthlyMicro: recommended,
    canLower: recommended < p.currentPriceMicro,
  };
}

/**
 * Starter credit is spent first. Charges beyond a workspace's starter grant are
 * recognised as revenue; the rest is a promotional cost.
 */
export function splitRevenue(cumulativeChargesMicro: number, starterGrantMicro: number): { revenueMicro: number; starterUsedMicro: number } {
  const starterUsedMicro = Math.min(cumulativeChargesMicro, starterGrantMicro);
  return { revenueMicro: cumulativeChargesMicro - starterUsedMicro, starterUsedMicro };
}

/** Spreads a cost entry evenly over its days (inclusive). */
export function dailyShare(amountMicro: number, periodStart: string, periodEnd: string, day: string): number {
  if (day < periodStart || day > periodEnd) return 0;
  const days = Math.round((Date.parse(periodEnd) - Date.parse(periodStart)) / 86_400_000) + 1;
  const index = Math.round((Date.parse(day) - Date.parse(periodStart)) / 86_400_000);
  return distribute(amountMicro, Array(days).fill(1))[index]!;
}
