import { useEffect, useId, useRef, useState } from "react";

export interface Series {
  key: string;
  label: string;
  /** CSS color, usually a var(--series-n) token. */
  color: string;
  values: number[];
  dashed?: boolean;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth || 600);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setW(el.clientWidth || 600));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Rounds the max up to a tidy number and returns 4 evenly spaced ticks from 0. */
/** Round tick values covering [min, max]; includes 0 and handles negatives (e.g. a reserve below zero). */
function niceTicks(min: number, max: number): number[] {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  if (hi - lo <= 0) return [0, 1];
  const rough = (hi - lo) / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? rough;
  const start = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= hi + step * 0.001; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  if (ticks[ticks.length - 1]! < hi) ticks.push(ticks[ticks.length - 1]! + step);
  return ticks;
}

const shortDate = (d: string) => {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, day ?? 1).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

/**
 * Small multi-series line chart in plain SVG. One y axis, a legend, a crosshair
 * tooltip (mouse or arrow keys), and a visually hidden data table.
 */
export function LineChart({
  title,
  days,
  series,
  format,
  axisFormat = format,
  height = 220,
}: {
  title: string;
  days: string[];
  series: Series[];
  format: (v: number) => string;
  axisFormat?: (v: number) => string;
  height?: number;
}) {
  const [wrap, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const tableId = useId();
  const n = days.length;
  const left = 64;
  const right = 12;
  const top = 10;
  const bottom = 26;
  const plotW = Math.max(40, width - left - right);
  const plotH = height - top - bottom;
  const all = series.flatMap((s) => s.values);
  const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
  const yMin = ticks[0]!;
  const yMax = ticks[ticks.length - 1]!;
  const x = (i: number) => left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;
  const xLabels = n <= 1 ? [0] : n === 2 ? [0, 1] : [0, Math.floor((n - 1) / 2), n - 1];

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left - left;
    const i = n <= 1 ? 0 : Math.round((px / plotW) * (n - 1));
    setActive(Math.min(n - 1, Math.max(0, i)));
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (n === 0) return;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = active === null ? n - 1 : Math.min(n - 1, active + 1);
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

  const last = n - 1;
  const valueText = (i: number) =>
    i < 0 || i >= n ? "No data" : `${shortDate(days[i]!)}: ${series.map((s) => `${s.label} ${format(s.values[i] ?? 0)}`).join(", ")}`;
  const summary =
    n === 0
      ? `${title}: no data yet.`
      : `${title}, ${shortDate(days[0]!)} to ${shortDate(days[last]!)}. Latest: ${series
          .map((s) => `${s.label} ${format(s.values[last] ?? 0)}`)
          .join(", ")}.`;
  const tipLeft = active === null ? 0 : Math.min(Math.max(x(active) - 80, 0), Math.max(0, width - 170));

  return (
    <figure className="chart">
      <figcaption className="chart-head">
        <span className="chart-title">{title}</span>
        {series.length > 1 && (
          <ul className="chart-legend">
            {series.map((s) => (
              <li key={s.key}>
                <svg width="18" height="8" aria-hidden="true">
                  <line x1="1" y1="4" x2="17" y2="4" stroke={s.color} strokeWidth="2.5" strokeDasharray={s.dashed ? "4 3" : undefined} />
                </svg>
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
        aria-label={`${title}. Use the arrow keys to read each day.`}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, n - 1)}
        aria-valuenow={active ?? Math.max(0, n - 1)}
        aria-valuetext={valueText(active ?? n - 1)}
      >
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={summary}
          onPointerMove={onMove}
          onPointerLeave={() => setActive(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={left} x2={left + plotW} y1={y(t)} y2={y(t)} className="chart-grid" />
              <text x={left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="chart-axis">
                {axisFormat(t)}
              </text>
            </g>
          ))}
          {n > 0 &&
            xLabels.map((i) => (
              <text
                key={i}
                x={x(i)}
                y={height - 6}
                textAnchor={n > 1 && i === 0 ? "start" : n > 1 && i === n - 1 ? "end" : "middle"}
                className="chart-axis"
              >
                {shortDate(days[i]!)}
              </text>
            ))}
          {series.map((s) =>
            n === 1 ? (
              <circle key={s.key} cx={x(0)} cy={y(s.values[0] ?? 0)} r={4} fill={s.color} />
            ) : (
              <polyline
                key={s.key}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray={s.dashed ? "5 4" : undefined}
                points={s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}
              />
            ),
          )}
          {active !== null && (
            <g>
              <line x1={x(active)} x2={x(active)} y1={top} y2={top + plotH} className="chart-cross" />
              {series.map((s) => (
                <circle
                  key={s.key}
                  cx={x(active)}
                  cy={y(s.values[active] ?? 0)}
                  r={4.5}
                  fill={s.color}
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
              ))}
            </g>
          )}
        </svg>
        <div className="chart-tip" style={{ left: tipLeft, visibility: active === null ? "hidden" : "visible" }} aria-hidden="true">
          {active !== null && (
            <>
              <strong>{shortDate(days[active]!)}</strong>
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
      <table className="sr-only" id={tableId}>
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            {series.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((d, i) => (
            <tr key={d}>
              <th scope="row">{d}</th>
              {series.map((s) => (
                <td key={s.key}>{format(s.values[i] ?? 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
