import { useId, useState } from "react";
import { niceTicks, useWidth } from "./LineChart";

export interface BarSeries {
  key: string;
  label: string;
  /** CSS color, usually a var(--series-n) token. */
  color: string;
  values: number[];
}

/**
 * Grouped vertical bar chart in plain SVG. Same reading model as LineChart:
 * hover or arrow keys show one category, and a visually hidden table has every value.
 */
export function BarChart({
  title,
  categories,
  series,
  format = String,
  height = 200,
  columnLabel = "Category",
}: {
  title: string;
  /** Display labels along the x axis. */
  categories: string[];
  series: BarSeries[];
  format?: (v: number) => string;
  height?: number;
  columnLabel?: string;
}) {
  const [wrap, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const tableId = useId();
  const n = categories.length;
  const left = 40;
  const right = 8;
  const top = 10;
  const plotW = Math.max(40, width - left - right);
  const n0 = Math.max(1, categories.length);
  // Axis labels: one line if they fit, else two lines, else every k-th label.
  const charW = 6.4;
  const longest = Math.max(0, ...categories.map((c) => c.length));
  const split = (c: string): string[] => {
    const words = c.split(" ");
    if (words.length < 2) return [c];
    let best: string[] = [c];
    let bestW = Number.POSITIVE_INFINITY;
    for (let k = 1; k < words.length; k++) {
      const a = words.slice(0, k).join(" ");
      const b = words.slice(k).join(" ");
      const w = Math.max(a.length, b.length);
      if (w < bestW) {
        bestW = w;
        best = [a, b];
      }
    }
    return best;
  };
  const fitsOne = longest * charW + 6 <= plotW / n0;
  const twoLine = !fitsOne && Math.max(0, ...categories.map((c) => Math.max(...split(c).map((x) => x.length)))) * charW + 6 <= plotW / n0;
  const bottom = twoLine ? 38 : 26;
  const plotH = height - top - bottom;
  const ticks = niceTicks(0, Math.max(4, ...series.flatMap((s) => s.values)));
  const yMax = ticks[ticks.length - 1]!;
  const y = (v: number) => top + plotH - (v / (yMax || 1)) * plotH;
  const band = n ? plotW / n : plotW;
  const inner = Math.min(28, (band * 0.72) / Math.max(1, series.length));
  const groupW = inner * series.length;
  const bx = (i: number, s: number) => left + band * i + (band - groupW) / 2 + inner * s;
  const every = fitsOne || twoLine ? 1 : Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / (longest * charW + 10)))));

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left - left) / band);
    setActive(i >= 0 && i < n ? i : null);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (n === 0) return;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = active === null ? 0 : Math.min(n - 1, active + 1);
    if (e.key === "ArrowLeft") next = active === null ? n - 1 : Math.max(0, active - 1);
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = n - 1;
    if (e.key === "Escape") {
      setActive(null);
      return;
    }
    if (next === null) return;
    e.preventDefault();
    setActive(next);
  };
  const valueText = (i: number) => `${categories[i]}: ${series.map((s) => `${s.label} ${format(s.values[i] ?? 0)}`).join(", ")}`;
  const totals = series.map((s) => `${s.label} ${format(s.values.reduce((a, b) => a + b, 0))} in total`).join(", ");
  const tipLeft = active === null ? 0 : Math.min(Math.max(left + band * active + band / 2 - 80, 0), Math.max(0, width - 170));

  return (
    <figure className="chart">
      <figcaption className="chart-head">
        <span className="chart-title">{title}</span>
        {series.length > 1 && (
          <ul className="chart-legend">
            {series.map((s) => (
              <li key={s.key}>
                <span className="chart-swatch" style={{ background: s.color }} aria-hidden="true" />
                {s.label}
              </li>
            ))}
          </ul>
        )}
      </figcaption>
      <div
        ref={wrap}
        className="chart-plot"
        tabIndex={n > 0 ? 0 : -1}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
        role="slider"
        aria-label={`${title}. Use the arrow keys to read each bar.`}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, n - 1)}
        aria-valuenow={active ?? 0}
        aria-valuetext={n === 0 ? "No data" : valueText(active ?? 0)}
      >
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`${title}. ${totals}.`}
          onPointerMove={onMove}
          onPointerLeave={() => setActive(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={left} x2={left + plotW} y1={y(t)} y2={y(t)} className="chart-grid" />
              <text x={left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="chart-axis">
                {format(t)}
              </text>
            </g>
          ))}
          {active !== null && <rect x={left + band * active} y={top} width={band} height={plotH} className="chart-band" />}
          {categories.map((c, i) =>
            series.map((s, si) => {
              const v = s.values[i] ?? 0;
              const h = Math.max(0, y(0) - y(v));
              return (
                <rect
                  key={`${c}-${s.key}`}
                  x={bx(i, si)}
                  y={y(v)}
                  width={Math.max(1, inner - 2)}
                  height={v > 0 ? Math.max(1.5, h) : 0}
                  rx={2}
                  fill={s.color}
                />
              );
            }),
          )}
          {categories.map((c, i) =>
            i % every === 0 ? (
              <text key={c} x={left + band * i + band / 2} y={twoLine ? height - 20 : height - 6} textAnchor="middle" className="chart-axis">
                {twoLine
                  ? split(c).map((line, li) => (
                      <tspan key={line} x={left + band * i + band / 2} dy={li === 0 ? 0 : 13}>
                        {line}
                      </tspan>
                    ))
                  : c}
              </text>
            ) : null,
          )}
        </svg>
        <div className="chart-tip" style={{ left: tipLeft, visibility: active === null ? "hidden" : "visible" }} aria-hidden="true">
          {active !== null && (
            <>
              <strong>{categories[active]}</strong>
              {series.map((s) => (
                <span key={s.key} className="chart-tip-row">
                  <span className="chart-swatch" style={{ background: s.color }} aria-hidden="true" />
                  {s.label}: {format(s.values[active] ?? 0)}
                </span>
              ))}
            </>
          )}
        </div>
      </div>
      <div className="sr-only">
      <table id={tableId}>
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">{columnLabel}</th>
            {series.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {categories.map((c, i) => (
            <tr key={c}>
              <th scope="row">{c}</th>
              {series.map((s) => (
                <td key={s.key}>{format(s.values[i] ?? 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </figure>
  );
}
