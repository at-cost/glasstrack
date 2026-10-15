import { describe, expect, it } from "vitest";
import { localDay, nextRun, type RecurrenceRule, zonedToUtc } from "./recurrence";

const rule = (r: Partial<RecurrenceRule>): RecurrenceRule => ({
  frequency: "daily", interval: 1, weekdays: [], monthDay: null, hour: 9, timezone: "UTC", startsOn: "2026-01-05", ...r,
});
const iso = (d: Date | null) => d?.toISOString() ?? null;
const runs = (r: RecurrenceRule, from: string, n: number) => {
  const out: string[] = [];
  let at = new Date(from);
  for (let i = 0; i < n; i++) {
    const next = nextRun(r, at);
    if (!next) break;
    out.push(next.toISOString());
    at = next;
  }
  return out;
};

describe("time zones", () => {
  it("converts local wall time to UTC across daylight saving", () => {
    expect(iso(zonedToUtc("2026-01-15", 9, "Europe/London"))).toBe("2026-01-15T09:00:00.000Z");
    expect(iso(zonedToUtc("2026-07-15", 9, "Europe/London"))).toBe("2026-07-15T08:00:00.000Z");
    expect(iso(zonedToUtc("2026-07-15", 9, "America/New_York"))).toBe("2026-07-15T13:00:00.000Z");
    expect(localDay(new Date("2026-03-01T03:00:00Z"), "America/Los_Angeles")).toBe("2026-02-28");
  });
});

describe("nextRun", () => {
  it("daily, every 2 days, starting on startsOn", () => {
    expect(runs(rule({ interval: 2 }), "2026-01-01T00:00:00Z", 3)).toEqual([
      "2026-01-05T09:00:00.000Z", "2026-01-07T09:00:00.000Z", "2026-01-09T09:00:00.000Z",
    ]);
  });
  it("is strictly after the given moment", () => {
    expect(iso(nextRun(rule({}), new Date("2026-01-05T09:00:00Z")))).toBe("2026-01-06T09:00:00.000Z");
    expect(iso(nextRun(rule({}), new Date("2026-01-05T08:59:00Z")))).toBe("2026-01-05T09:00:00.000Z");
  });
  it("weekly on Mon and Thu, every other week", () => {
    // 2026-01-05 is a Monday.
    expect(runs(rule({ frequency: "weekly", interval: 2, weekdays: [1, 4] }), "2026-01-01T00:00:00Z", 4)).toEqual([
      "2026-01-05T09:00:00.000Z", "2026-01-08T09:00:00.000Z", "2026-01-19T09:00:00.000Z", "2026-01-22T09:00:00.000Z",
    ]);
  });
  it("monthly on the 31st clamps to short months", () => {
    expect(runs(rule({ frequency: "monthly", monthDay: 31, startsOn: "2026-01-01" }), "2026-01-01T00:00:00Z", 4)).toEqual([
      "2026-01-31T09:00:00.000Z", "2026-02-28T09:00:00.000Z", "2026-03-31T09:00:00.000Z", "2026-04-30T09:00:00.000Z",
    ]);
  });
  it("yearly on 29 Feb falls back to 28 Feb", () => {
    expect(runs(rule({ frequency: "yearly", startsOn: "2028-02-29" }), "2028-03-01T00:00:00Z", 2)).toEqual([
      "2029-02-28T09:00:00.000Z", "2030-02-28T09:00:00.000Z",
    ]);
  });
  it("keeps the local hour through a DST change", () => {
    const r = rule({ timezone: "Europe/London", startsOn: "2026-03-27" });
    expect(runs(r, "2026-03-27T00:00:00Z", 3)).toEqual([
      "2026-03-27T09:00:00.000Z", "2026-03-28T09:00:00.000Z", "2026-03-29T08:00:00.000Z",
    ]);
  });
  it("never runs before startsOn", () => {
    expect(iso(nextRun(rule({ startsOn: "2027-06-01" }), new Date("2026-01-01T00:00:00Z")))).toBe("2027-06-01T09:00:00.000Z");
  });
});
