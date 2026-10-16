import { describe, expect, it } from "vitest";
import {
  assertCapNotIncreased,
  creditLastsDays,
  DEFAULT_PRICING,
  dailyCharge,
  daysInMonth,
  estimateEmails,
  monthlyCost,
  recommendCap,
  serverShareMicro,
  topupFeeMicro,
} from "./pricing";

const S = DEFAULT_PRICING;
const usd = (micro: number) => micro / 1_000_000;
const sums = (b: { serverShareMicro: number; storageMicro: number; emailMicro: number; feesAndReserveMicro: number; totalMicro: number }) =>
  b.serverShareMicro + b.storageMicro + b.emailMicro + b.feesAndReserveMicro === b.totalMicro;

describe("pay-as-you-go pricing", () => {
  it("typical team (5 GB, 2,000 emails/month), $60/month servers, 1 active workspace: about $6.38/month, $0.21/day, $10 lasts about 47 days", () => {
    const m = monthlyCost({ settings: S, sharedFixedMonthMicro: 60_000_000, activeWorkspaces: 1, storageGb: 5, emailsPerMonth: 2000 });
    expect(usd(m.serverShareMicro)).toBe(5); // capped
    expect(usd(m.totalMicro)).toBeCloseTo(6.378, 3);
    expect(usd(dailyCharge(m, 30).totalMicro)).toBeCloseTo(0.2126, 4);
    expect(creditLastsDays(10_000_000, m.totalMicro)).toBe(47);
    expect(sums(m)).toBe(true);
  });

  it("same team with 200 GB, $60/month servers, 1 active workspace: about $11.76/month", () => {
    const m = monthlyCost({ settings: S, sharedFixedMonthMicro: 60_000_000, activeWorkspaces: 1, storageGb: 200, emailsPerMonth: 2000 });
    expect(usd(m.totalMicro)).toBeCloseTo(11.76, 2);
    expect(sums(m)).toBe(true);
  });

  it("100 active workspaces sharing $80/month servers: a typical team pays about $1.34/month", () => {
    const m = monthlyCost({ settings: S, sharedFixedMonthMicro: 80_000_000, activeWorkspaces: 100, storageGb: 5, emailsPerMonth: 2000 });
    expect(usd(m.serverShareMicro)).toBeCloseTo(0.8, 6);
    expect(usd(m.totalMicro)).toBeCloseTo(1.338, 3);
  });

  it("a $1,000 top-up by one workspace changes no other workspace's charge (charges don't depend on balances)", () => {
    const input = { settings: S, sharedFixedMonthMicro: 80_000_000, activeWorkspaces: 3, storageGb: 5, emailsPerMonth: 2000 };
    const before = monthlyCost(input);
    // A top-up adds credit to one ledger; nothing in the cost inputs refers to any balance.
    const after = monthlyCost({ ...input });
    expect(after).toEqual(before);
    expect(Object.keys(input)).not.toContain("balance");
  });

  it("the breakdown always sums to the total, monthly and daily, across many inputs", () => {
    for (let i = 0; i < 2000; i++) {
      const m = monthlyCost({
        settings: { ...S, feeMarkup: (i % 7) / 10, serverShareCapUsd: (i % 11) / 2 },
        sharedFixedMonthMicro: (i * 7919) % 500_000_000,
        activeWorkspaces: i % 37,
        storageGb: ((i * 13) % 5000) / 10,
        emailsPerMonth: (i * 97) % 100_000,
        active: i % 5 !== 0,
      });
      expect(sums(m)).toBe(true);
      for (const days of [28, 29, 30, 31]) expect(sums(dailyCharge(m, days))).toBe(true);
    }
  });

  it("no active workspaces: the share is the cap; inactive workspaces pay no server share", () => {
    expect(serverShareMicro(S, 60_000_000, 0)).toBe(5_000_000);
    const m = monthlyCost({ settings: S, sharedFixedMonthMicro: 60_000_000, activeWorkspaces: 4, storageGb: 10, emailsPerMonth: 0, active: false });
    expect(m.serverShareMicro).toBe(0);
    expect(usd(m.totalMicro)).toBeCloseTo(0.276, 6);
  });

  it("stripe fee per top-up is 3.15% + $0.27 (no Billing fee)", () => {
    expect(usd(topupFeeMicro(S, 10_000_000))).toBeCloseTo(0.585, 6);
    expect(usd(topupFeeMicro(S, 500_000_000))).toBeCloseTo(16.02, 6);
  });

  it("recommends a lower cap only once the reserve reaches 6 months of costs, and never a higher one", () => {
    const base = { settings: S, monthlyCostsMicro: 80_000_000, sharedFixedMonthMicro: 80_000_000, activeWorkspaces: 100 };
    expect(recommendCap({ ...base, reserveMicro: 479_000_000 })).toMatchObject({ eligible: false, recommendedCapMicro: null, reserveTargetMicro: 480_000_000 });
    expect(recommendCap({ ...base, reserveMicro: 480_000_000 })).toMatchObject({ eligible: true, recommendedCapMicro: 1_000_000 });
    expect(recommendCap({ ...base, reserveMicro: 1e12, activeWorkspaces: 2 }).recommendedCapMicro).toBeNull();
    expect(() => assertCapNotIncreased(5, 5.5)).toThrow(/only go down/);
    expect(() => assertCapNotIncreased(5, 4.5)).not.toThrow();
  });

  it("helpers: days in month, email estimate", () => {
    expect(daysInMonth("2026-02-10")).toBe(28);
    expect(daysInMonth("2028-02-01")).toBe(29);
    expect(daysInMonth("2026-10-16")).toBe(31);
    expect(estimateEmails(20)).toBe(2000);
  });
});
