/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import type { PublicFinances } from "../finances/public";
import { assetUrl, hasAsset } from "./assets";

/** "October 2026", or "1 to 16 Oct so far" when the figures are month to date. */
export function periodLabel(f: PublicFinances): string {
  if (f.monthToDate) {
    const d = (s: string) => new Date(`${s}T00:00:00Z`);
    const from = d(f.monthToDate.from);
    const to = d(f.monthToDate.to);
    const mon = to.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
    return `${from.getUTCDate()} to ${to.getUTCDate()} ${mon} so far`;
  }
  const [y, m] = f.thisMonth.month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export const updatedLabel = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";

export function Fig(p: { label: Child; value: Child; id?: string }) {
  return (
    <div class="fig">
      <dt>{p.label}</dt>
      <dd id={p.id}>{p.value}</dd>
    </div>
  );
}

/** Reserve progress: balance against target. */
export function Meter(p: { value: number; max: number; label: string }) {
  const pct = p.max > 0 ? Math.min(100, Math.max(0, (p.value / p.max) * 100)) : 0;
  return (
    <div class="meter" role="progressbar" aria-label={p.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
      <span style={`width:${pct.toFixed(1)}%`} />
    </div>
  );
}

const SHOT = { w: 1280, h: 800 };

/**
 * A real product screenshot in light and dark. <source media> follows the
 * system; the site script rewrites the media queries when the toggle forces a theme.
 */
export function Shot(p: { name: string; alt: string; priority?: boolean; sizes?: string }) {
  const src = (theme: string, w: number) => `shots/${p.name}-${theme}-${w}.webp`;
  if (!hasAsset(src("light", 1280))) return null;
  const set = (theme: string) => [640, 960, 1280].map((w) => `${assetUrl(src(theme, w))} ${w}w`).join(", ");
  const sizes = p.sizes ?? "(min-width: 72rem) 68rem, 100vw";
  return (
    <picture>
      <source data-dark-source media="(prefers-color-scheme: dark)" srcset={set("dark")} sizes={sizes} />
      <img
        src={assetUrl(src("light", 1280))}
        srcset={set("light")}
        sizes={sizes}
        width={SHOT.w}
        height={SHOT.h}
        alt={p.alt}
        loading={p.priority ? "eager" : "lazy"}
        fetchpriority={p.priority ? "high" : undefined}
        decoding="async"
      />
    </picture>
  );
}

/** JSON for the browser scripts, safe inside a <script> element. */
export function DataScript(p: { id: string; data: unknown }) {
  const json = JSON.stringify(p.data).replace(/</g, "\\u003c");
  return <script type="application/json" id={p.id} dangerouslySetInnerHTML={{ __html: json }} />;
}

export const ArrowLink = (p: { href: string; children: Child }) => (
  <p>
    <a href={p.href}>{p.children} &rarr;</a>
  </p>
);
