/** @jsxImportSource hono/jsx */
/**
 * Minimal server-drawn SVG charts. One y axis, thin marks, a legend for two
 * series plus a dashed second line (identity is never colour alone), a native
 * tooltip (<title>) on every mark, and a data table beside each chart.
 */

const W = 420;
const H = 200;
const PAD = { l: 52, r: 12, t: 12, b: 28 };

/** Axis top. Never below $10 (amounts are micro-USD), so an all-zero series still reads as $0. */
function niceMax(v: number): number {
  if (v <= 10_000_000) return 10_000_000;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

const monthLabel = (m: string) => {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
};

export interface Series {
  name: string;
  cls: "a" | "b" | "warm";
  dashed?: boolean;
  values: number[];
}

function Axes(p: { max: number; fmt: (v: number) => string; labels: string[]; x: (i: number) => number }) {
  const ticks = [0, 0.5, 1].map((f) => f * p.max);
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / p.max);
  const every = Math.max(1, Math.ceil(p.labels.length / 6));
  return (
    <>
      <g class="grid">
        {ticks.map((t) => (
          <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />
        ))}
      </g>
      <g class="axis">
        {ticks.map((t) => (
          <text x={PAD.l - 8} y={y(t) + 4} text-anchor="end">
            {p.fmt(t)}
          </text>
        ))}
        {p.labels.map((l, i) =>
          i % every === 0 || i === p.labels.length - 1 ? (
            <text x={p.x(i)} y={H - 8} text-anchor="middle">
              {monthLabel(l)}
            </text>
          ) : null,
        )}
      </g>
    </>
  );
}

export function LineChart(p: { id: string; title: string; months: string[]; series: Series[]; fmt: (v: number) => string }) {
  const n = p.months.length;
  const max = niceMax(Math.max(0, ...p.series.flatMap((s) => s.values)));
  const x = (i: number) => (n <= 1 ? (PAD.l + W - PAD.r) / 2 : PAD.l + ((W - PAD.l - PAD.r) * i) / (n - 1));
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - Math.max(0, v) / max);
  return (
    <figure class="chart">
      {p.series.length > 1 && (
        <ul class="legend">
          {p.series.map((s) => (
            <li>
              <svg viewBox="0 0 22 10" aria-hidden="true">
                <line x1="1" x2="21" y1="5" y2="5" class={`s-${s.cls}`} stroke-width="2.5" stroke-dasharray={s.dashed ? "4 3" : undefined} />
              </svg>
              {s.name}
            </li>
          ))}
        </ul>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${p.id}-t`}>
        <title id={`${p.id}-t`}>{p.title}. The table below has the same figures.</title>
        <Axes max={max} fmt={p.fmt} labels={p.months} x={x} />
        {p.series.map((s) => (
          <g>
            {n > 1 && (
              <polyline
                fill="none"
                class={`s-${s.cls}`}
                stroke-width="2"
                stroke-linejoin="round"
                stroke-dasharray={s.dashed ? "5 4" : undefined}
                points={s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}
              />
            )}
            {s.values.map((v, i) => (
              <circle class={`dot f-${s.cls}`} cx={x(i)} cy={y(v)} r={n > 1 ? 3.5 : 5}>
                <title>
                  {s.name}, {monthLabel(p.months[i]!)}: {p.fmt(v)}
                </title>
              </circle>
            ))}
          </g>
        ))}
      </svg>
    </figure>
  );
}

export function BarChart(p: { id: string; title: string; months: string[]; values: number[]; name: string; cls: Series["cls"]; fmt: (v: number) => string }) {
  const n = p.months.length;
  const max = niceMax(Math.max(0, ...p.values));
  const slot = (W - PAD.l - PAD.r) / Math.max(1, n);
  const bw = Math.min(36, Math.max(4, slot - 6));
  const x = (i: number) => PAD.l + slot * i + slot / 2;
  const base = H - PAD.b;
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - Math.max(0, v) / max);
  return (
    <figure class="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${p.id}-t`}>
        <title id={`${p.id}-t`}>{p.title}. The table below has the same figures.</title>
        <Axes max={max} fmt={p.fmt} labels={p.months} x={x} />
        {p.values.map((v, i) => {
          const top = y(v);
          const h = Math.max(0, base - top);
          const r = Math.min(4, h / 2, bw / 2);
          // Rounded top, square base
          const d = `M${x(i) - bw / 2},${base} V${top + r} Q${x(i) - bw / 2},${top} ${x(i) - bw / 2 + r},${top} H${x(i) + bw / 2 - r} Q${x(i) + bw / 2},${top} ${x(i) + bw / 2},${top + r} V${base} Z`;
          return (
            <path class={`f-${p.cls}`} d={h > 0 ? d : `M${x(i) - bw / 2},${base} h${bw} v-1 h-${bw} Z`}>
              <title>
                {p.name}, {monthLabel(p.months[i]!)}: {p.fmt(v)}
              </title>
            </path>
          );
        })}
      </svg>
    </figure>
  );
}

export { monthLabel };
