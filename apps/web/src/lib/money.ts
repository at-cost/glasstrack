import { formatUsd, MICRO } from "@glasstrack/shared";

export { formatUsd, MICRO };

/** Compact dollars for chart axes: $0, $12, $1.5k. */
export function usdAxis(micro: number): string {
  const d = micro / MICRO;
  if (Math.abs(d) >= 1000) return `$${(d / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })}k`;
  if (Math.abs(d) >= 10 || d === 0) return `$${Math.round(d).toLocaleString("en-US")}`;
  return `$${d.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/** Signed amount for ledgers: +$10.00 / -$0.16. */
export function signedUsd(micro: number): string {
  return `${micro > 0 ? "+" : ""}${formatUsd(micro, { precise: true })}`;
}

/** Micro-USD as a plain number for inputs: 25, 2.5. */
export function microToInput(micro: number): string {
  return String(Math.round((micro / MICRO) * 100) / 100);
}

export function percent(bp: number): string {
  return `${(bp / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}

export function shortDate(iso: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00`) : new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
