import DOMPurify from "dompurify";

type Mermaid = typeof import("mermaid")["default"];
type Mode = "light" | "dark";

let loader: Promise<Mermaid> | null = null;
let initialisedFor: Mode | null = null;
let counter = 0;

/** Loads mermaid on first use (its own chunk), set up for the current light or dark mode. */
async function load(mode: Mode): Promise<Mermaid> {
  loader ??= import("mermaid").then((m) => m.default);
  const mermaid = await loader;
  if (initialisedFor !== mode) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: mode === "dark" ? "dark" : "default",
      fontFamily: "inherit",
    });
    initialisedFor = mode;
  }
  return mermaid;
}

// One render at a time: mermaid keeps global state while it draws.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

function failNote(pre: HTMLElement) {
  if (pre.nextElementSibling?.classList.contains("mermaid-error")) return;
  const note = document.createElement("p");
  note.className = "mermaid-error";
  note.textContent = "Diagram couldn't be drawn";
  pre.after(note);
}

/**
 * Turns ```mermaid code blocks inside `root` into diagrams. Already drawn
 * diagrams are redrawn when the mode changed. The code stays readable when a
 * diagram has an error.
 */
export async function renderMermaidIn(root: HTMLElement, mode: Mode, cancelled: () => boolean): Promise<void> {
  const fresh = [...root.querySelectorAll<HTMLElement>("pre > code.language-mermaid")].map((code) => ({
    el: code.parentElement!,
    src: code.textContent ?? "",
  }));
  const stale = [...root.querySelectorAll<HTMLElement>(".mermaid-block")]
    .filter((el) => el.dataset.mode !== mode)
    .map((el) => ({ el, src: el.dataset.source ?? "" }));
  const targets = [...fresh, ...stale];
  if (targets.length === 0) return;
  let mermaid: Mermaid;
  try {
    mermaid = await load(mode);
  } catch {
    for (const t of fresh) failNote(t.el);
    return;
  }
  for (const t of targets) {
    if (cancelled()) return;
    const id = `gt-mermaid-${++counter}`;
    try {
      const { svg } = await serial(async () => {
        if (initialisedFor !== mode) await load(mode);
        return mermaid.render(id, t.src);
      });
      if (cancelled() || !t.el.isConnected) return;
      const block = document.createElement("div");
      block.className = "mermaid-block";
      block.dataset.source = t.src;
      block.dataset.mode = mode;
      block.setAttribute("role", "img");
      block.setAttribute("aria-label", "Diagram");
      // Mermaid's strict mode already sanitises labels; this is a second pass on the SVG.
      block.innerHTML = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true, html: true },
        ADD_TAGS: ["foreignObject", "style"],
        HTML_INTEGRATION_POINTS: { foreignobject: true },
      });
      if (t.el.nextElementSibling?.classList.contains("mermaid-error")) t.el.nextElementSibling.remove();
      t.el.replaceWith(block);
    } catch {
      // mermaid leaves its scratch element behind on errors
      document.getElementById(`d${id}`)?.remove();
      document.getElementById(id)?.remove();
      if (cancelled() || !t.el.isConnected) return;
      if (t.el.tagName === "PRE") failNote(t.el);
    }
  }
}
