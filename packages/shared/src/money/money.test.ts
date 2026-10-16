import { describe, expect, it } from "vitest";
import {
  dailyShare,
  distribute,
  formatUsd,
  GIB,
  MICRO,
  nextBillingState,
  splitRevenue,
  usdToMicro,
} from "./index";

const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n));

describe("charges", () => {
  it("formats", () => {
    expect(formatUsd(usdToMicro(10))).toBe("$10.00");
    expect(formatUsd(-328_767, { precise: true })).toBe("-$0.3288");
  });
});

describe("billing state", () => {
  const base = { status: "active" as const, balanceMicro: 0, graceStartedAt: null, warningsSent: 0 };
  it("enters grace when the balance runs out and warns on days 0, 3 and 6", () => {
    const t0 = nextBillingState(base, day(0));
    expect(t0).toMatchObject({ status: "grace", warningsSent: 1, email: { kind: "grace_warning", day: 0, daysLeft: 7 } });
    const s = (n: number, prev: typeof t0) => nextBillingState({ status: prev.status, balanceMicro: -1, graceStartedAt: prev.graceStartedAt, warningsSent: prev.warningsSent }, day(n));
    const t1 = s(1, t0);
    expect(t1.email).toBeNull();
    const t3 = s(3, t1);
    expect(t3.email).toMatchObject({ kind: "grace_warning", day: 3, daysLeft: 4 });
    const t5 = s(5, t3);
    expect(t5.email).toBeNull();
    const t6 = s(6, t5);
    expect(t6.email).toMatchObject({ kind: "grace_warning", daysLeft: 1 });
    const t7 = s(7, t6);
    expect(t7).toMatchObject({ status: "read_only", email: { kind: "read_only" } });
    expect(s(8, t7)).toMatchObject({ status: "read_only", email: null });
  });
  it("a missed run still sends one catch-up warning, not several", () => {
    const g = { status: "grace" as const, balanceMicro: -5, graceStartedAt: day(0), warningsSent: 1 };
    const t = nextBillingState(g, day(6));
    expect(t.warningsSent).toBe(3);
    expect(t.email).toMatchObject({ kind: "grace_warning" });
  });
  it("topping up restores the workspace", () => {
    const t = nextBillingState({ status: "read_only", balanceMicro: 5_000_000, graceStartedAt: day(0), warningsSent: 3 }, day(9));
    expect(t).toEqual({ status: "active", graceStartedAt: null, warningsSent: 0, email: { kind: "restored" } });
    expect(nextBillingState({ ...base, balanceMicro: 1 }, day(0)).email).toBeNull();
  });
});

describe("distribute", () => {
  it("always sums exactly to the total", () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let t = 0; t < 500; t++) {
      const n = 1 + Math.floor(rand() * 20);
      const weights = Array.from({ length: n }, () => (rand() < 0.2 ? 0 : Math.floor(rand() * 1000)));
      const total = Math.floor(rand() * 10_000_000);
      const parts = distribute(total, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      expect(parts.every((p) => p >= 0 && Number.isInteger(p))).toBe(true);
    }
  });
  it("is proportional and splits evenly with no weights", () => {
    expect(distribute(100, [1, 1, 2])).toEqual([25, 25, 50]);
    expect(distribute(10, [0, 0, 0])).toEqual([4, 3, 3]);
  });
});

describe("revenue and cost spreading", () => {
  it("starter credit is spent first and is not revenue", () => {
    expect(splitRevenue(usdToMicro(4), usdToMicro(10))).toEqual({ revenueMicro: 0, starterUsedMicro: usdToMicro(4) });
    expect(splitRevenue(usdToMicro(15), usdToMicro(10))).toEqual({ revenueMicro: usdToMicro(5), starterUsedMicro: usdToMicro(10) });
  });
  it("spreads a monthly cost over its days exactly", () => {
    const total = usdToMicro(31.07);
    let sum = 0;
    for (let d = 1; d <= 31; d++) sum += dailyShare(total, "2026-01-01", "2026-01-31", `2026-01-${String(d).padStart(2, "0")}`);
    expect(sum).toBe(total);
    expect(dailyShare(total, "2026-01-01", "2026-01-31", "2026-02-01")).toBe(0);
  });
});
