/** Money formatting shared by the server pages and the browser scripts. Amounts are integer micro-USD. */
const MICRO = 1_000_000;

/** "$6.38" (always two decimals). */
export function usd(micro: number): string {
  const d = micro / MICRO;
  const s = Math.abs(d).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${d < 0 ? "-" : ""}$${s}`;
}

/** "$6" (rounded to the dollar). */
export function usdWhole(micro: number): string {
  const d = Math.round(micro / MICRO);
  return `${d < 0 ? "-" : ""}$${Math.abs(d).toLocaleString("en-US")}`;
}

/** "$200" for whole dollars, "$6.38" otherwise. */
export function usdShort(micro: number): string {
  return micro % MICRO === 0 ? usdWhole(micro) : usd(micro);
}

export const int = (n: number): string => Math.round(n).toLocaleString("en-US");

/**
 * Rounds each line of a breakdown to whole cents so the rounded lines add up to
 * the rounded total (largest remainder). Display only; the maths stays in micro-USD.
 */
export function centsSplit(partsMicro: number[], totalMicro: number): number[] {
  const totalCents = Math.round(totalMicro / 10_000);
  const raw = partsMicro.map((m) => m / 10_000);
  const cents = raw.map(Math.floor);
  let rest = totalCents - cents.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (let k = 0; rest > 0 && order.length > 0; k = (k + 1) % order.length, rest--) cents[order[k]!.i]! += 1;
  for (let k = order.length - 1; rest < 0 && order.length > 0; k = (k - 1 + order.length) % order.length) {
    if (cents[order[k]!.i]! > 0) {
      cents[order[k]!.i]! -= 1;
      rest++;
    }
  }
  return cents.map((c) => c * 10_000);
}
