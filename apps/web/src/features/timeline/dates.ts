/** Day arithmetic for the timeline. Days are whole numbers (days since 1970-01-01, UTC) so DST never shifts a bar. */

const DAY_MS = 86_400_000;

export function dayNum(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(Date.UTC(y!, (m ?? 1) - 1, d ?? 1) / DAY_MS);
}

export function isoOf(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = Monday. */
export function weekday(n: number): number {
  return (new Date(n * DAY_MS).getUTCDay() + 6) % 7;
}

export function parts(n: number): { y: number; m: number; d: number } {
  const t = new Date(n * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() };
}

export function monthStart(y: number, m: number): number {
  return Math.round(Date.UTC(y, m, 1) / DAY_MS);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthName = (m: number) => MONTHS[m]!;

export type Zoom = "weeks" | "months" | "quarters";

/** Pixels per day at each zoom level. */
export const PPD: Record<Zoom, number> = { weeks: 32, months: 9, quarters: 3 };

export interface Tick {
  start: number;
  end: number;
  label: string;
}

/** Header rows (top: months or quarters; bottom: days, weeks or months) for [lo, hi). */
export function headerTicks(zoom: Zoom, lo: number, hi: number): { top: Tick[]; bottom: Tick[]; lines: number[] } {
  const months: Tick[] = [];
  const first = parts(lo);
  for (let y = first.y, m = first.m; ; m++) {
    if (m > 11) {
      m = 0;
      y++;
    }
    const s = monthStart(y, m);
    if (s >= hi) break;
    const e = monthStart(m === 11 ? y + 1 : y, (m + 1) % 12);
    months.push({
      start: Math.max(s, lo),
      end: Math.min(e, hi),
      label: m === 0 || months.length === 0 ? `${monthName(m)} ${y}` : monthName(m),
    });
  }
  if (zoom === "weeks") {
    const bottom: Tick[] = [];
    for (let n = lo; n < hi; n++) bottom.push({ start: n, end: n + 1, label: String(parts(n).d) });
    const lines: number[] = [];
    for (let n = lo; n < hi; n++) if (weekday(n) === 0) lines.push(n);
    return { top: months, bottom, lines };
  }
  if (zoom === "months") {
    const bottom: Tick[] = [];
    let n = lo;
    while (weekday(n) !== 0) n++;
    for (; n < hi; n += 7) bottom.push({ start: n, end: Math.min(n + 7, hi), label: String(parts(n).d) });
    return { top: months, bottom, lines: months.map((t) => t.start) };
  }
  const quarters: Tick[] = [];
  for (const t of months) {
    const p = parts(t.start);
    const q = Math.floor(p.m / 3);
    const last = quarters[quarters.length - 1];
    const label = `Q${q + 1} ${p.y}`;
    if (last && last.label === label) last.end = t.end;
    else quarters.push({ start: t.start, end: t.end, label });
  }
  return { top: quarters, bottom: months.map((t) => ({ ...t, label: monthName(parts(t.start).m) })), lines: months.map((t) => t.start) };
}

/** Visible range: covers every date plus padding, aligned to the zoom's unit. */
export function visibleRange(zoom: Zoom, dates: number[], today: number): { lo: number; hi: number } {
  let lo = Math.min(today - 14, ...dates);
  let hi = Math.max(today + 28, ...dates) + 1;
  const pad = { weeks: 7, months: 21, quarters: 45 }[zoom];
  const minSpan = { weeks: 70, months: 210, quarters: 450 }[zoom];
  lo -= pad;
  hi += pad;
  if (zoom === "weeks") lo -= weekday(lo);
  else {
    const p = parts(lo);
    lo = zoom === "months" ? monthStart(p.y, p.m) : monthStart(p.y, Math.floor(p.m / 3) * 3);
  }
  if (hi - lo < minSpan) hi = lo + minSpan;
  return { lo, hi };
}
