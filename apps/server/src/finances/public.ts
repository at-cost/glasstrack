import { DEFAULT_PRICING, type PricingSettings } from "@glasstrack/shared";
import type { Deps } from "../context";
import { logger } from "../lib/logger";

/**
 * Public, aggregate-only money data for the website (/, /pricing, /finances)
 * and /api/v1/public/*. Nothing here identifies a workspace.
 * All amounts are integer micro-USD.
 */

export interface PublicPricing {
  settings: PricingSettings;
  /** This month's shared fixed costs (servers, database, domain, monitoring, AI and tools). */
  sharedFixedMonthMicro: number;
  /** Workspaces with activity in the last 30 days. */
  activeWorkspaces: number;
  /** True when no real costs are recorded yet and the figures are an example. */
  example: boolean;
  updatedAt: string;
}

export interface PublicCostLine {
  label: string;
  amountMicro: number;
  /** Shown at list price but paid with provider credits (e.g. AWS credits). */
  paidByCredits: boolean;
}

export interface PublicMonth {
  /** YYYY-MM */
  month: string;
  /** Credit actually used by workspaces (signup credit excluded). */
  revenueMicro: number;
  totalCostMicro: number;
  /** costs + payment fees − revenue, when positive. */
  founderGapMicro: number;
  reserveMicro: number;
  activeWorkspaces: number;
  payingWorkspaces: number;
  costPerWorkspaceMicro: number;
  serverShareCapMicro: number;
}

export interface PublicFinances {
  example: boolean;
  updatedAt: string;
  /** The days "this month" covers so far (month to date), YYYY-MM-DD. */
  monthToDate?: { from: string; to: string };
  thisMonth: PublicMonth & {
    costs: PublicCostLine[];
    paymentFeesMicro: number;
    /** Unused prepaid balances. Not income; never counts toward the reserve. */
    creditHeldMicro: number;
  };
  reserve: { balanceMicro: number; targetMicro: number; targetMonths: number };
  serverShareCapMicro: number;
  /** A lower cap the operator may apply once the reserve target is met; never applied automatically. */
  recommendedCapMicro: number | null;
  capHistory: { from: string; capMicro: number; reason: string }[];
  /** Oldest first, up to 24 months. */
  history: PublicMonth[];
  /** Changes that made running Glasstrack cheaper. */
  savings: { date: string; change: string; savingMonthMicro: number }[];
}

const M = 1_000_000;

/** Example figures used until real costs exist. Every page showing them must label them "Example". */
export function exampleFinances(now = new Date()): PublicFinances {
  const month = now.toISOString().slice(0, 7);
  const costs: PublicCostLine[] = [
    { label: "Servers (AWS EC2)", amountMicro: 30 * M, paidByCredits: true },
    { label: "Database backups and storage (AWS S3)", amountMicro: 2 * M, paidByCredits: true },
    { label: "Email (AWS SES)", amountMicro: 1 * M, paidByCredits: true },
    { label: "Domain", amountMicro: 1 * M, paidByCredits: false },
    { label: "AI and tooling", amountMicro: 26 * M, paidByCredits: false },
  ];
  const total = costs.reduce((a, c) => a + c.amountMicro, 0);
  const cap = DEFAULT_PRICING.serverShareCapUsd * M;
  const row: PublicMonth = {
    month, revenueMicro: 0, totalCostMicro: total, founderGapMicro: total, reserveMicro: 0, activeWorkspaces: 0, payingWorkspaces: 0,
    costPerWorkspaceMicro: 0, serverShareCapMicro: cap,
  };
  return {
    example: true,
    updatedAt: now.toISOString(),
    thisMonth: { ...row, costs, paymentFeesMicro: 0, creditHeldMicro: 0 },
    reserve: { balanceMicro: 0, targetMicro: DEFAULT_PRICING.reserveTargetMonths * total, targetMonths: DEFAULT_PRICING.reserveTargetMonths },
    serverShareCapMicro: cap,
    recommendedCapMicro: null,
    capHistory: [{ from: now.toISOString(), capMicro: cap, reason: "Starting cap" }],
    history: [row],
    savings: [],
  };
}

export function examplePricing(now = new Date()): PublicPricing {
  return { settings: DEFAULT_PRICING, sharedFixedMonthMicro: 60 * M, activeWorkspaces: 1, example: true, updatedAt: now.toISOString() };
}

let cache: { at: number; pricing: PublicPricing; finances: PublicFinances } | null = null;
const HOUR = 60 * 60_000;

/** Cached for an hour. Real figures come from the finance tables (publicData.ts); the example until costs exist. */
export async function getPublicPricing(deps: Deps): Promise<PublicPricing> {
  return (await load(deps)).pricing;
}

export async function getPublicFinances(deps: Deps): Promise<PublicFinances> {
  return (await load(deps)).finances;
}

export function clearPublicCache() {
  cache = null;
}

async function load(deps: Deps) {
  if (cache && Date.now() - cache.at < HOUR) return cache;
  const { computePublic } = await import("./publicData");
  const real = await computePublic(deps).catch((err) => {
    logger.error({ err }, "public finances failed; showing the example");
    return null;
  });
  cache = { at: Date.now(), pricing: real?.pricing ?? examplePricing(), finances: real?.finances ?? exampleFinances() };
  return cache;
}

const usd = (m: number) => (m / M).toFixed(2);

/** One row per month, oldest first. */
export function financesCsv(f: PublicFinances): string {
  const head = ["month", "revenue_usd", "total_cost_usd", "covered_by_founder_usd", "reserve_usd", "active_workspaces", "paying_workspaces", "cost_per_workspace_usd", "server_share_cap_usd", "example"];
  const rows = f.history.map((r) => [r.month, usd(r.revenueMicro), usd(r.totalCostMicro), usd(r.founderGapMicro), usd(r.reserveMicro), r.activeWorkspaces, r.payingWorkspaces, usd(r.costPerWorkspaceMicro), usd(r.serverShareCapMicro), f.example ? "yes" : "no"]);
  return [head, ...rows].map((r) => r.join(",")).join("\n") + "\n";
}
