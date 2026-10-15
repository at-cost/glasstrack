import { useEffect, useState } from "react";
import { toISODate } from "./format";

/** 205 -> "3h 25m", 60 -> "1h", 5 -> "5m", 0 -> "0m". */
export function formatMinutes(total: number): string {
  const m = Math.max(0, Math.round(total));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

/**
 * Reads a duration typed by a person: "90", "1h 30m", "1h30", "1.5h", "45m", "2h".
 * A bare number is minutes. Returns null when it can't be read.
 */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (/^\d+:\d{1,2}$/.test(s)) {
    const [h, m] = s.split(":").map(Number);
    return h! * 60 + m!;
  }
  const re = /^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*(?:m(?:in(?:utes?|s)?)?)?)?$/;
  const m = re.exec(s);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  const minutes = Math.round(Number(m[1] ?? 0) * 60) + Number(m[2] ?? 0);
  return minutes > 0 ? minutes : null;
}

/** h:mm:ss for a running timer. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}

/** Re-renders every second while `active`, returning the current time. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** Monday..Sunday of the week containing `d`, as YYYY-MM-DD. */
export function weekRange(d = new Date()): { from: string; to: string } {
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const offset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - offset);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { from: toISODate(start), to: toISODate(end) };
}

/** Quotes a value for CSV. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  // Stop spreadsheet apps from running text as a formula.
  if (typeof v === "string" && /^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function downloadCsv(filename: string, rows: unknown[][]) {
  const text = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob([`﻿${text}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
