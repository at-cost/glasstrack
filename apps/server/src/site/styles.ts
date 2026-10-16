/**
 * Public site stylesheet, inlined into every page (about 12 KB before gzip), so
 * the first paint needs no extra request. "Clear ledger": paper, hairline rules,
 * tabular figures. Contrast ratios are listed next to each text colour.
 */
export const css = `
@font-face {
  font-family: "Plex Mono";
  src: url("__FONT__") format("woff2");
  font-weight: 500;
  font-style: normal;
  font-display: swap;
}
:root {
  color-scheme: light;
  --paper: #f7f6f2;
  --surface: #ffffff;
  --ink: #15181b;        /* 16.5:1 on paper */
  --ink-2: #545a5f;      /* 6.5:1 on paper, 7.0:1 on surface */
  --rule: #dcd9cf;       /* decorative hairline */
  --rule-strong: #8a8f93;/* 3.0:1, input and control borders */
  --accent: #2f5d50;     /* 6.9:1 on paper as text */
  --on-accent: #ffffff;  /* 7.5:1 on accent */
  --accent-soft: #e4ece7;
  --warm: #b8762a;       /* reserve bar only, 3.4:1 on paper */
  --track: #e8e5dc;
  --series-a: #0f7f58;
  --series-b: #8a4f9e;
  --edge: rgb(47 93 80 / 35%);
  --focus: #2f5d50;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: "Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --wrap: 72rem;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --paper: #0e1113;
    --surface: #161b1e;
    --ink: #e6e8e6;        /* 15.4:1 */
    --ink-2: #9aa29f;      /* 7.3:1 on paper, 6.7:1 on surface */
    --rule: #2a3135;
    --rule-strong: #7d8388;/* 4.9:1 */
    --accent: #86c5b0;     /* 9.6:1 */
    --on-accent: #0e1113;  /* 9.6:1 */
    --accent-soft: #1b2a26;
    --warm: #c9822b;       /* 6.1:1 */
    --track: #232a2e;
    --series-a: #3b9d78;
    --series-b: #a170c4;
    --edge: rgb(134 197 176 / 30%);
    --focus: #86c5b0;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --paper: #0e1113;
  --surface: #161b1e;
  --ink: #e6e8e6;
  --ink-2: #9aa29f;
  --rule: #2a3135;
  --rule-strong: #7d8388;
  --accent: #86c5b0;
  --on-accent: #0e1113;
  --accent-soft: #1b2a26;
  --warm: #c9822b;
  --track: #232a2e;
  --series-a: #3b9d78;
  --series-b: #a170c4;
  --edge: rgb(134 197 176 / 30%);
  --focus: #86c5b0;
}
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font: 16px/1.6 var(--sans);
  overflow-wrap: break-word;
}
img, svg { max-width: 100%; height: auto; }
a { color: var(--accent); text-underline-offset: 0.18em; }
a:hover { text-decoration-thickness: 2px; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; border-radius: 3px; }
h1, h2, h3 { line-height: 1.2; margin: 0 0 0.6em; letter-spacing: -0.01em; }
h1 { font-size: clamp(2rem, 5.2vw, 3.4rem); font-weight: 700; letter-spacing: -0.025em; }
h2 { font-size: clamp(1.45rem, 3vw, 1.9rem); font-weight: 650; }
h3 { font-size: 1.1rem; font-weight: 650; }
p { margin: 0 0 1em; }
ul, ol { padding-left: 1.2em; }
li { margin: 0.3em 0; }
code, .num, .mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
code { font-size: 0.92em; }
.num { white-space: nowrap; }
.muted { color: var(--ink-2); }
.small { font-size: 0.9rem; }
.wrap { max-width: var(--wrap); margin: 0 auto; padding: 0 16px; }
@media (min-width: 640px) { .wrap { padding: 0 28px; } }
.skip { position: absolute; left: 8px; top: -60px; background: var(--ink); color: var(--paper); padding: 8px 14px; z-index: 10; border-radius: 4px; }
.skip:focus { top: 8px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

/* Header */
.top { border-bottom: 1px solid var(--rule); }
.top .wrap { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 20px; min-height: 64px; padding-top: 8px; padding-bottom: 8px; }
.brand { display: inline-flex; align-items: center; gap: 9px; color: var(--ink); text-decoration: none; font-weight: 700; font-size: 1.05rem; }
.brand svg { width: 26px; height: 26px; }
.nav { display: flex; flex-wrap: wrap; gap: 2px 16px; order: 3; width: 100%; font-size: 0.95rem; }
.nav a { color: var(--ink-2); text-decoration: none; padding: 6px 0; }
.nav a:hover, .nav a[aria-current="page"] { color: var(--ink); text-decoration: underline; }
.top-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
@media (min-width: 860px) {
  .nav { order: 0; width: auto; }
}
@media (max-width: 459px) {
  .hide-xs { display: none !important; }
  .nav { flex-wrap: nowrap; overflow-x: auto; gap: 14px; font-size: 0.92rem; white-space: nowrap; scrollbar-width: none; }
}

/* Buttons */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  min-height: 44px; padding: 0 18px; border-radius: 6px;
  border: 1px solid var(--rule-strong); background: var(--surface); color: var(--ink);
  font: inherit; font-weight: 600; text-decoration: none; cursor: pointer;
}
.btn:hover { border-color: var(--ink); }
.btn-primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.btn-primary:hover { filter: brightness(1.08); border-color: var(--accent); }
.btn-sm { min-height: 36px; padding: 0 12px; font-size: 0.92rem; }
.icon-btn { width: 40px; min-height: 40px; padding: 0; }
.icon-btn svg { width: 18px; height: 18px; }
.actions { display: flex; flex-wrap: wrap; gap: 12px; margin: 26px 0 0; }

/* Sections and rules */
main { display: block; }
.section { padding: 56px 0; border-top: 1px solid var(--rule); }
.section:first-child { border-top: 0; }
.section-head { max-width: 46rem; margin-bottom: 28px; }
.section-head p { color: var(--ink-2); font-size: 1.05rem; }
.eyebrow { font-family: var(--mono); font-size: 0.8rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-2); margin: 0 0 10px; }
.lede { font-size: clamp(1.08rem, 2.1vw, 1.25rem); color: var(--ink-2); max-width: 44rem; }
.prose { max-width: 42rem; }
.prose p, .prose li { font-size: 1.07rem; }
.page-head { padding: 52px 0 28px; }
.page-head h1 { font-size: clamp(1.9rem, 4.4vw, 2.8rem); }
.grid-2 { display: grid; gap: 28px; grid-template-columns: minmax(0, 1fr); }
.grid-3 { display: grid; gap: 22px; grid-template-columns: minmax(0, 1fr); }
.grid-2 > *, .grid-3 > *, .mini-calc > *, .tour-item > * { min-width: 0; }
@media (min-width: 760px) {
  .grid-2 { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 40px; }
  .grid-3 { grid-template-columns: repeat(3, 1fr); }
}

/* Hero */
.hero { padding: 56px 0 40px; }
.hero h1 { max-width: 15em; }
.fn { font-size: 0.7em; vertical-align: super; line-height: 0; text-decoration: none; margin-left: 1px; }
.shot {
  position: relative; margin: 40px 0 0; border-radius: 10px; border: 1px solid var(--rule);
  background: var(--surface); overflow: hidden;
  box-shadow: 0 1px 0 var(--rule), 0 18px 50px -24px rgb(20 30 25 / 35%);
}
.shot::before {
  /* the one "glass" detail: a faint refraction along the top edge */
  content: ""; position: absolute; inset: 0 0 auto 0; height: 1px;
  background: linear-gradient(90deg, transparent, var(--edge) 20%, rgb(255 255 255 / 60%) 50%, var(--edge) 80%, transparent);
  pointer-events: none;
}
.shot img { display: block; width: 100%; height: auto; }
figure { margin: 0; }
figcaption { font-size: 0.9rem; color: var(--ink-2); margin-top: 10px; }

/* Ledger tables */
.ledger { width: 100%; border-collapse: collapse; font-size: 0.98rem; }
.ledger caption { text-align: left; font-weight: 650; padding-bottom: 8px; }
.ledger th, .ledger td { text-align: left; padding: 10px 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
.ledger th { font-weight: 600; }
.ledger thead th { font-size: 0.85rem; color: var(--ink-2); font-weight: 600; border-bottom-color: var(--rule-strong); }
.ledger td.r, .ledger th.r { text-align: right; padding-left: 16px; font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ledger tfoot td, .ledger tfoot th { border-top: 1px solid var(--ink); border-bottom: 0; font-weight: 700; }
.ledger .note { display: block; font-size: 0.85rem; color: var(--ink-2); font-weight: 400; }
.table-scroll { overflow-x: auto; }
.ledger code { overflow-wrap: anywhere; }
.tag { display: inline-block; font-size: 0.78rem; padding: 1px 7px; border: 1px solid var(--rule-strong); border-radius: 99px; color: var(--ink-2); margin-left: 6px; white-space: nowrap; font-weight: 500; }

/* Example labelling */
.example { display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 0.75rem; letter-spacing: 0.06em; text-transform: uppercase; padding: 2px 8px; border: 1px dashed var(--ink-2); border-radius: 4px; color: var(--ink); background: var(--surface); vertical-align: middle; }
.example-note { font-size: 0.92rem; color: var(--ink-2); margin: 8px 0 18px; }

/* Figures */
.figure-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); border-top: 1px solid var(--rule); border-left: 1px solid var(--rule); }
.fig { padding: 16px 18px; border-right: 1px solid var(--rule); border-bottom: 1px solid var(--rule); background: var(--surface); }
.fig dt { font-size: 0.85rem; color: var(--ink-2); margin-bottom: 6px; }
.fig dd { margin: 0; font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 1.45rem; letter-spacing: -0.02em; }
.big { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: clamp(2.6rem, 8vw, 4rem); letter-spacing: -0.04em; line-height: 1; }

/* Progress bar (reserve) */
.meter { height: 10px; background: var(--track); border-radius: 5px; overflow: hidden; margin: 8px 0; border: 1px solid var(--rule); }
.meter > span { display: block; height: 100%; background: var(--warm); min-width: 2px; }

/* Price card and calculator */
fieldset.card { margin: 0; min-width: 0; }
.card { background: var(--surface); border: 1px solid var(--rule); border-radius: 10px; padding: 22px; position: relative; }
.price-card { overflow: hidden; }
.price-card::before {
  content: ""; position: absolute; inset: 0 0 auto 0; height: 1px;
  background: linear-gradient(90deg, transparent, var(--edge) 20%, rgb(255 255 255 / 60%) 50%, var(--edge) 80%, transparent);
}
.field { display: grid; gap: 6px; margin-bottom: 20px; }
.field label, .field .label { font-weight: 600; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.field output, .field .val { font-family: var(--mono); font-variant-numeric: tabular-nums; font-weight: 500; }
.hint { font-size: 0.88rem; color: var(--ink-2); }
input[type="range"] { width: 100%; accent-color: var(--accent); height: 28px; margin: 0; background: transparent; }
input[type="number"] {
  font: inherit; font-family: var(--mono); width: 9rem; min-height: 44px; padding: 0 10px;
  border: 1px solid var(--rule-strong); border-radius: 6px; background: var(--surface); color: var(--ink);
}
.inline-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.linkish { background: none; border: 0; padding: 0; font: inherit; color: var(--accent); text-decoration: underline; cursor: pointer; min-height: 32px; }
.compare { list-style: none; padding: 0; margin: 0; }
.compare li { display: flex; justify-content: space-between; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--rule); margin: 0; }
.compare li.us { font-weight: 700; }
.mini-calc { display: grid; gap: 24px; align-items: start; }
@media (min-width: 760px) { .mini-calc { grid-template-columns: 1fr 1.1fr; gap: 40px; } }

/* Tour */
.tour { display: grid; gap: 44px; }
.tour-item { display: grid; gap: 18px; align-items: center; }
@media (min-width: 860px) {
  .tour-item { grid-template-columns: 0.8fr 1.2fr; gap: 40px; }
  .tour-item:nth-child(even) .tour-text { order: 2; }
}
.tour-item .shot { margin: 0; }
.also { margin-top: 36px; color: var(--ink-2); }

/* Points */
.points { list-style: none; padding: 0; margin: 0; counter-reset: p; }
.points li { border-top: 1px solid var(--rule); padding: 16px 0 6px 44px; position: relative; margin: 0; }
.points li::before { counter-increment: p; content: counter(p, decimal-leading-zero); position: absolute; left: 0; top: 17px; font-family: var(--mono); color: var(--ink-2); font-size: 0.9rem; }
.status-pill { display: inline-block; font-size: 0.78rem; padding: 2px 8px; border-radius: 4px; border: 1px solid var(--rule-strong); font-family: var(--mono); text-transform: uppercase; letter-spacing: 0.05em; }

/* FAQ */
details { border-bottom: 1px solid var(--rule); }
details:first-of-type { border-top: 1px solid var(--rule); }
summary { cursor: pointer; padding: 16px 0; font-weight: 600; list-style-position: outside; }
summary::marker { color: var(--ink-2); }
details > div { padding: 0 0 16px; max-width: 46rem; color: var(--ink); }
.maths { margin-top: 22px; }
.maths pre { background: var(--surface); border: 1px solid var(--rule); padding: 14px; border-radius: 6px; overflow-x: auto; font-size: 0.88rem; line-height: 1.55; }

/* Code blocks with copy buttons */
.steps { counter-reset: s; list-style: none; padding: 0; }
.steps > li { margin: 0 0 22px; }
.code { position: relative; background: var(--surface); border: 1px solid var(--rule); border-radius: 6px; margin-top: 8px; }
.code pre { margin: 0; padding: 14px 16px; overflow-x: auto; font-family: var(--mono); font-size: 0.9rem; line-height: 1.55; }
.code .copy { position: absolute; top: 6px; right: 6px; }
.code:has(.copy:not([hidden])) pre { padding-right: 84px; }

/* Charts */
.chart { margin: 0 0 28px; }
.chart svg { display: block; width: 100%; max-width: 640px; height: auto; overflow: visible; }
.chart .grid line { stroke: var(--rule); stroke-width: 1; }
.chart .axis text, .chart .lbl { fill: var(--ink-2); font-size: 12px; font-family: var(--mono); }
.chart .s-a { stroke: var(--series-a); }
.chart .s-b { stroke: var(--series-b); }
.chart .f-a { fill: var(--series-a); }
.chart .f-b { fill: var(--series-b); }
.chart .f-warm { fill: var(--warm); }
.chart .s-warm { stroke: var(--warm); }
.chart .dot { stroke: var(--surface); stroke-width: 2; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 18px; list-style: none; padding: 0; margin: 0 0 8px; font-size: 0.9rem; color: var(--ink-2); }
.legend li { display: inline-flex; align-items: center; gap: 7px; margin: 0; }
.legend svg { width: 22px; height: 10px; }

/* Footer */
.foot { border-top: 1px solid var(--rule); margin-top: 40px; padding: 36px 0 48px; font-size: 0.93rem; }
.foot nav ul { list-style: none; padding: 0; margin: 0 0 18px; display: flex; flex-wrap: wrap; gap: 4px 20px; }
.foot nav li { margin: 0; }
.foot a { color: var(--ink); }
.foot p { color: var(--ink-2); margin: 0 0 6px; }
.placeholder { font-family: var(--mono); font-size: 0.92em; background: var(--accent-soft); color: var(--ink); padding: 1px 5px; border-radius: 3px; }

@media (prefers-reduced-motion: no-preference) { html { scroll-behavior: smooth; } }
@media print { .top-actions, .skip, .copy { display: none !important; } }
`;
