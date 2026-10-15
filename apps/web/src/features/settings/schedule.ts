import { isValidTimeZone, nextRun, type RecurringIssue } from "@glasstrack/shared";
import { parseDateOnly } from "../../lib/format";

export type Schedule = Pick<RecurringIssue, "frequency" | "interval" | "weekdays" | "monthDay" | "hour" | "timezone" | "startsOn">;

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Monday first, as most calendars outside the US show it. */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

const UNIT: Record<Schedule["frequency"], [string, string]> = {
  daily: ["day", "days"],
  weekly: ["week", "weeks"],
  monthly: ["month", "months"],
  yearly: ["year", "years"],
};

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function timeZones(): string[] {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (fn) return fn("timeZone");
  } catch {
    // older browsers
  }
  return ["UTC", browserTimeZone()];
}

const joinWords = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
export const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

/** "Every 2 weeks on Monday and Thursday at 09:00, Europe/London" */
export function describeSchedule(s: Schedule): string {
  const [one, many] = UNIT[s.frequency];
  const every = s.interval > 1 ? `Every ${s.interval} ${many}` : `Every ${one}`;
  const start = s.startsOn ? parseDateOnly(s.startsOn) : new Date();
  let on = "";
  if (s.frequency === "weekly") {
    const days = s.weekdays.length ? s.weekdays : [start.getDay()];
    on = ` on ${joinWords(WEEKDAY_ORDER.filter((d) => days.includes(d)).map((d) => WEEKDAYS[d]!))}`;
  } else if (s.frequency === "monthly") {
    on = ` on day ${s.monthDay ?? start.getDate()}`;
  } else if (s.frequency === "yearly") {
    on = ` on ${start.toLocaleDateString(undefined, { day: "numeric", month: "long" })}`;
  }
  return `${every}${on} at ${hourLabel(s.hour)}, ${s.timezone}`;
}

/** Next run after now, computed with the same rules as the server. */
export function previewNextRun(s: Schedule): Date | null {
  if (!s.startsOn || !isValidTimeZone(s.timezone) || s.interval < 1) return null;
  try {
    return nextRun({ ...s, monthDay: s.monthDay ?? null }, new Date());
  } catch {
    return null;
  }
}

/** The run time in the viewer's own clock, plus the schedule's zone when it differs. */
export function formatRunTime(iso: string | Date, tz: string): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const local = d.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  if (tz === browserTimeZone()) return local;
  try {
    const there = d.toLocaleString(undefined, { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit" });
    return `${local} (${there} in ${tz})`;
  } catch {
    return local;
  }
}
