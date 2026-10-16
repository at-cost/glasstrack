/**
 * Money maths for billing and public finances. Pure functions, no I/O.
 * All amounts are integer micro-USD (1 USD = 1,000,000) so daily pro-rata
 * charges are exact; convert to cents only for Stripe.
 */

export const MICRO = 1_000_000;
export const GIB = 1024 ** 3;

export const usdToMicro = (usd: number): number => Math.round(usd * MICRO);
export const microToCents = (micro: number): number => Math.round(micro / 10_000);
export const centsToMicro = (cents: number): number => cents * 10_000;

export function formatUsd(micro: number, opts: { precise?: boolean } = {}): string {
  const dollars = micro / MICRO;
  const digits = opts.precise && Math.abs(micro) % 10_000 !== 0 ? 4 : 2;
  return `${dollars < 0 ? "-" : ""}$${Math.abs(dollars).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
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
export * from "./pricing";
