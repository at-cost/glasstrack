/**
 * Per-seat prices of other trackers, for the comparisons on / and /pricing.
 * Checked by hand on each vendor's official pricing page; update `checkedOn` when you re-check.
 * We use the lowest advertised price (billed yearly) so the comparison is fair to them.
 */
export interface Competitor {
  vendor: string;
  plan: string;
  /** USD per user per month. */
  perUserMonthUsd: number;
  /** Teams this size or smaller pay nothing (a free plan). */
  freeUpToUsers?: number;
  basis: string;
  source: string;
  checkedOn: string;
}

export const COMPETITORS: Competitor[] = [
  {
    vendor: "Linear",
    plan: "Basic",
    perUserMonthUsd: 10,
    basis: "per user per month, billed yearly",
    source: "https://linear.app/pricing",
    checkedOn: "2026-10-16",
  },
  {
    vendor: "Plane",
    plan: "Pro",
    perUserMonthUsd: 6,
    basis: "per seat per month, billed yearly ($8 billed monthly)",
    source: "https://plane.so/pricing",
    checkedOn: "2026-10-16",
  },
  {
    vendor: "Trello",
    plan: "Standard",
    perUserMonthUsd: 5,
    basis: "per user per month, billed yearly ($6 billed monthly)",
    source: "https://trello.com/pricing",
    checkedOn: "2026-10-16",
  },
  {
    vendor: "Jira",
    plan: "Standard",
    perUserMonthUsd: 8.48,
    freeUpToUsers: 10,
    basis: "per user per month, billed monthly; free for up to 10 users; yearly billing is priced in user bands and saves up to 17%",
    source: "https://www.atlassian.com/software/jira/pricing",
    checkedOn: "2026-10-17",
  },
];

/** What a team of this size pays per month on a competitor's plan. */
export const competitorMonthly = (c: Pick<Competitor, "perUserMonthUsd" | "freeUpToUsers">, people: number): number =>
  c.freeUpToUsers !== undefined && people <= c.freeUpToUsers ? 0 : c.perUserMonthUsd * people;
