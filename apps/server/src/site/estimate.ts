import { estimateEmails, monthlyCost, type CostBreakdown } from "@glasstrack/shared/pricing";
import type { PublicPricing } from "../finances/public";

/** The "typical team" every headline figure uses. */
export const TYPICAL = { people: 20, storageGb: 5 } as const;

export function estimate(p: PublicPricing, people: number, storageGb: number, emails = estimateEmails(people)): CostBreakdown {
  return monthlyCost({
    settings: p.settings,
    sharedFixedMonthMicro: p.sharedFixedMonthMicro,
    activeWorkspaces: p.activeWorkspaces,
    storageGb,
    emailsPerMonth: emails,
  });
}

export const typicalMonthly = (p: PublicPricing) => estimate(p, TYPICAL.people, TYPICAL.storageGb);
