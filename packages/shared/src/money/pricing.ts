/**
 * Pay-as-you-go pricing at cost. The one place the price is worked out: the
 * nightly charge, the public calculator and the finances page all call these
 * functions, so they can never disagree. Pure functions, no I/O.
 *
 *   server_share_month = min(server_share_cap, shared_fixed_costs_month / active_workspaces)
 *   usage_month        = storage_gb × storage_rate + emails / 1000 × email_rate
 *   monthly_cost       = (server_share_month + usage_month) × (1 + fee_markup)
 *   daily_charge       = monthly_cost / days_in_month
 *
 * Money is integer micro-USD (1 USD = 1,000,000) so every breakdown sums exactly.
 */

const MICRO = 1_000_000;

/** Operator-editable settings (stored as versioned rows; see pricing_settings). */
export interface PricingSettings {
  signupCreditUsd: number;
  /** Most a workspace pays towards shared servers per month. Only ever decreases. */
  serverShareCapUsd: number;
  /** Added on top of cost to cover payment fees and build the reserve. */
  feeMarkup: number;
  minTopupUsd: number;
  maxTopupUsd: number;
  storageUsdPerGbMonth: number;
  emailUsdPer1000: number;
  /** Stripe's fee per top-up: percent of the amount plus a fixed part. */
  stripeFeePercent: number;
  stripeFeeFixedUsd: number;
  /** Months of running costs to hold in reserve before the cap is lowered. */
  reserveTargetMonths: number;
}

export const DEFAULT_PRICING: PricingSettings = {
  signupCreditUsd: 10,
  serverShareCapUsd: 5,
  feeMarkup: 0.2,
  minTopupUsd: 10,
  maxTopupUsd: 500,
  storageUsdPerGbMonth: 0.023,
  emailUsdPer1000: 0.1,
  stripeFeePercent: 0.0315,
  stripeFeeFixedUsd: 0.27,
  reserveTargetMonths: 3,
};

/** Average month length, for estimates (the nightly charge uses the real month). */
export const AVG_DAYS_PER_MONTH = 365 / 12;
/** Calculator default: emails a team sends per person per month (notifications, digests). */
export const EMAILS_PER_PERSON_MONTH = 100;

export const estimateEmails = (teamSize: number): number => Math.round(Math.max(0, teamSize) * EMAILS_PER_PERSON_MONTH);

const toMicro = (usd: number) => Math.round(usd * MICRO);

/** The server share for one active workspace this month, in micro-USD. With no active workspaces, the cap. */
export function serverShareMicro(s: PricingSettings, sharedFixedMonthMicro: number, activeWorkspaces: number): number {
  const cap = toMicro(s.serverShareCapUsd);
  if (activeWorkspaces <= 0) return cap;
  return Math.min(cap, Math.round(Math.max(0, sharedFixedMonthMicro) / activeWorkspaces));
}

export interface CostInput {
  settings: PricingSettings;
  /** Shared fixed costs for the month: servers, database, domain, monitoring, AI and tools (not storage or email). */
  sharedFixedMonthMicro: number;
  activeWorkspaces: number;
  storageGb: number;
  emailsPerMonth: number;
  /** Workspaces with no activity in 30 days pay for their storage and email only. Default true. */
  active?: boolean;
}

export interface CostBreakdown {
  serverShareMicro: number;
  storageMicro: number;
  emailMicro: number;
  /** Cost before the markup. */
  subtotalMicro: number;
  /** The fee_markup part: payment fees and the reserve. */
  feesAndReserveMicro: number;
  /** subtotal + feesAndReserve, exactly. */
  totalMicro: number;
}

/** What a workspace costs per month, line by line. The lines always sum to the total. */
export function monthlyCost(p: CostInput): CostBreakdown {
  const s = p.settings;
  const server = p.active === false ? 0 : serverShareMicro(s, p.sharedFixedMonthMicro, p.activeWorkspaces);
  const storage = Math.round(Math.max(0, p.storageGb) * s.storageUsdPerGbMonth * MICRO);
  const email = Math.round((Math.max(0, p.emailsPerMonth) / 1000) * s.emailUsdPer1000 * MICRO);
  const subtotal = server + storage + email;
  const total = Math.round(subtotal * (1 + s.feeMarkup));
  return { serverShareMicro: server, storageMicro: storage, emailMicro: email, subtotalMicro: subtotal, feesAndReserveMicro: total - subtotal, totalMicro: total };
}

/** Days in the calendar month of an ISO day (YYYY-MM-DD). */
export function daysInMonth(day: string): number {
  const [y, m] = day.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * One day's charge, split so the parts sum exactly to the total. Each line is
 * its monthly amount ÷ days in that month, rounded; the markup line absorbs rounding.
 */
export function dailyCharge(month: CostBreakdown, days: number): CostBreakdown {
  const total = Math.round(month.totalMicro / days);
  const server = Math.round(month.serverShareMicro / days);
  const storage = Math.round(month.storageMicro / days);
  const email = Math.round(month.emailMicro / days);
  const subtotal = server + storage + email;
  return { serverShareMicro: server, storageMicro: storage, emailMicro: email, subtotalMicro: subtotal, feesAndReserveMicro: total - subtotal, totalMicro: total };
}

/** How many whole days a credit lasts at this monthly cost (average month). null = forever (no cost). */
export function creditLastsDays(creditMicro: number, monthlyTotalMicro: number): number | null {
  if (monthlyTotalMicro <= 0) return null;
  return Math.floor(creditMicro / (monthlyTotalMicro / AVG_DAYS_PER_MONTH));
}

/** Stripe's fee on one top-up, in micro-USD. */
export function topupFeeMicro(s: PricingSettings, amountMicro: number): number {
  return Math.round(amountMicro * s.stripeFeePercent + s.stripeFeeFixedUsd * MICRO);
}

/** A top-up amount is allowed (inclusive bounds). */
export function topupAllowed(s: PricingSettings, amountUsd: number): boolean {
  return Number.isFinite(amountUsd) && amountUsd >= s.minTopupUsd && amountUsd <= s.maxTopupUsd;
}

export interface CapRecommendation {
  /** The reserve has reached reserve_target_months × monthly costs. */
  eligible: boolean;
  reserveTargetMicro: number;
  /** A lower cap the operator may apply (never applied automatically), or null. */
  recommendedCapMicro: number | null;
}

/**
 * Once the reserve covers the target, recommend a cap equal to what each active
 * workspace actually needs to cover the servers, rounded up to the next $0.25.
 * Never higher than the current cap.
 */
export function recommendCap(p: {
  settings: PricingSettings;
  reserveMicro: number;
  monthlyCostsMicro: number;
  sharedFixedMonthMicro: number;
  activeWorkspaces: number;
}): CapRecommendation {
  const reserveTargetMicro = Math.round(p.settings.reserveTargetMonths * Math.max(0, p.monthlyCostsMicro));
  const eligible = p.monthlyCostsMicro > 0 && p.reserveMicro >= reserveTargetMicro;
  if (!eligible || p.activeWorkspaces <= 0) return { eligible, reserveTargetMicro, recommendedCapMicro: null };
  const step = MICRO / 4;
  const needed = Math.max(step, Math.ceil(p.sharedFixedMonthMicro / p.activeWorkspaces / step) * step);
  const cap = toMicro(p.settings.serverShareCapUsd);
  return { eligible, reserveTargetMicro, recommendedCapMicro: needed < cap ? needed : null };
}

/** The cap may only go down. Throws otherwise. */
export function assertCapNotIncreased(currentUsd: number | null, nextUsd: number): void {
  if (!Number.isFinite(nextUsd) || nextUsd < 0) throw new Error("The server share cap must be zero or more");
  if (currentUsd !== null && nextUsd > currentUsd) throw new Error(`The server share cap can only go down: $${nextUsd} > $${currentUsd}`);
}

/** Basic sanity for operator edits. Returns a message or null. */
export function validatePricingSettings(s: PricingSettings): string | null {
  const nonNeg = Object.entries(s).find(([, v]) => typeof v !== "number" || !Number.isFinite(v) || v < 0);
  if (nonNeg) return `${nonNeg[0]} must be a number, zero or more`;
  if (s.minTopupUsd > s.maxTopupUsd) return "The minimum top-up must not be above the maximum";
  if (s.minTopupUsd < 1) return "The minimum top-up must be at least $1";
  if (s.feeMarkup > 1) return "The fee markup is a fraction (0.2 = 20%)";
  if (s.stripeFeePercent > 0.2) return "The Stripe percent is a fraction (0.0315 = 3.15%)";
  return null;
}
