/**
 * Recurring issue schedules: the next run strictly after a moment, in the
 * rule's time zone. Pure functions so they can be tested exhaustively.
 */

export interface RecurrenceRule {
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  /** 0 = Sunday ... 6 = Saturday (weekly). Empty = the weekday of startsOn. */
  weekdays: number[];
  /** Day of month (monthly). Null = the day of startsOn. Clamped to short months. */
  monthDay: number | null;
  hour: number;
  timezone: string;
  /** YYYY-MM-DD, local to timezone. */
  startsOn: string;
}

const DAY = 86_400_000;
const parse = (d: string) => {
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  return { y, m, d: day };
};
const fmt = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const toDays = (d: string) => {
  const p = parse(d);
  return Date.UTC(p.y, p.m - 1, p.d) / DAY;
};
const fromDays = (n: number) => {
  const dt = new Date(n * DAY);
  return fmt(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
};
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Offset (minutes) of `tz` from UTC at the instant `utc`. */
function offsetMinutes(utc: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(utc);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - utc.getTime()) / 60_000);
}

/** The UTC instant of `hour:00` on local date `day` in `tz` (DST-safe). */
export function zonedToUtc(day: string, hour: number, tz: string): Date {
  const p = parse(day);
  const guess = Date.UTC(p.y, p.m - 1, p.d, hour);
  let t = guess - offsetMinutes(new Date(guess), tz) * 60_000;
  // Second pass settles DST transitions.
  t = guess - offsetMinutes(new Date(t), tz) * 60_000;
  return new Date(t);
}

/** Local calendar date of an instant in `tz`. */
export function localDay(utc: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(utc);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function matches(rule: RecurrenceRule, day: string): boolean {
  const start = parse(rule.startsOn);
  const d = parse(day);
  const n = toDays(day) - toDays(rule.startsOn);
  if (n < 0) return false;
  switch (rule.frequency) {
    case "daily":
      return n % rule.interval === 0;
    case "weekly": {
      const wd = new Date(toDays(day) * DAY).getUTCDay();
      const startWd = new Date(toDays(rule.startsOn) * DAY).getUTCDay();
      const days = rule.weekdays.length ? rule.weekdays : [startWd];
      if (!days.includes(wd)) return false;
      // Weeks counted from the Sunday on or before startsOn.
      const week0 = toDays(rule.startsOn) - startWd;
      return Math.floor((toDays(day) - week0) / 7) % rule.interval === 0;
    }
    case "monthly": {
      const months = (d.y - start.y) * 12 + (d.m - start.m);
      if (months % rule.interval !== 0) return false;
      const want = Math.min(rule.monthDay ?? start.d, daysInMonth(d.y, d.m));
      return d.d === want;
    }
    case "yearly": {
      if ((d.y - start.y) % rule.interval !== 0 || d.m !== start.m) return false;
      return d.d === Math.min(start.d, daysInMonth(d.y, d.m));
    }
  }
}

/** Next run strictly after `after`, or null if none within ~10 years. */
export function nextRun(rule: RecurrenceRule, after: Date): Date | null {
  const from = Math.max(toDays(rule.startsOn), toDays(localDay(after, rule.timezone)));
  for (let n = from; n < from + 3700; n++) {
    const day = fromDays(n);
    if (!matches(rule, day)) continue;
    const at = zonedToUtc(day, rule.hour, rule.timezone);
    if (at.getTime() > after.getTime()) return at;
  }
  return null;
}
