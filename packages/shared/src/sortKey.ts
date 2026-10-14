/**
 * Fractional index keys: base-62 digit strings read as fractions in (0, 1).
 * Lexicographic order equals numeric order, so moving an item between two
 * neighbours writes a single row. Keys never end in "0", which keeps every
 * fraction representable by exactly one string.
 */
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;

function digit(c: string): number {
  const i = DIGITS.indexOf(c);
  if (i < 0) throw new Error(`invalid sort key character: ${c}`);
  return i;
}

/** a: lower bound ("" = 0). b: upper bound (null = 1). Requires a < b. */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? "0") === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? digit(a[0]!) : 0;
  const db = b ? digit(b[0]!) : BASE;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)]!;
  if (b && b.length > 1) return b.slice(0, 1);
  return DIGITS[da]! + midpoint(a.slice(1), null);
}

function validate(k: string) {
  if (k === "" || k.endsWith("0")) throw new Error(`invalid sort key: "${k}"`);
  for (const c of k) digit(c);
}

/** Returns a key strictly between a and b. null means open-ended. */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null) validate(a);
  if (b !== null) validate(b);
  if (a !== null && b !== null && a >= b) throw new Error(`keyBetween: "${a}" >= "${b}"`);
  return midpoint(a ?? "", b);
}

/** n increasing keys after `after` (used when seeding). */
export function keysAfter(after: string | null, n: number): string[] {
  const out: string[] = [];
  let prev = after;
  for (let k = 0; k < n; k++) {
    prev = keyBetween(prev, null);
    out.push(prev);
  }
  return out;
}
