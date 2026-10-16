/**
 * Every public page: the theme toggle (system, light, dark), screenshots that
 * follow it, and copy buttons. Pages work without this script.
 */

type Choice = "system" | "light" | "dark";
const KEY = "glasstrack-theme";
const root = document.documentElement;
const dark = window.matchMedia("(prefers-color-scheme: dark)");

function saved(): Choice {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "dark" || v === "midnight") return "dark";
    if (v === "light" || v === "snow" || v === "contrast") return "light";
  } catch {
    // storage blocked
  }
  return "system";
}

function save(choice: Choice) {
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // storage blocked
  }
}

/** <picture> sources follow the system by media query; a forced theme overrides it. */
function syncPictures(choice: Choice) {
  for (const s of document.querySelectorAll<HTMLSourceElement>("source[data-dark-source]")) {
    const media = choice === "system" ? "(prefers-color-scheme: dark)" : choice === "dark" ? "all" : "not all";
    if (s.media !== media) s.media = media;
  }
}

function apply(choice: Choice) {
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
  syncPictures(choice);
  const showing = choice === "system" ? (dark.matches ? "dark" : "light") : choice;
  const label = `Switch to ${showing === "dark" ? "light" : "dark"} theme`;
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-theme-toggle]")) {
    b.setAttribute("aria-label", label);
    b.title = label;
  }
}

/** Flips what is showing. Landing back on the system's own theme means "follow the system" again. */
function next(choice: Choice): Choice {
  const system = dark.matches ? "dark" : "light";
  const showing = choice === "system" ? system : choice;
  const flipped = showing === "dark" ? "light" : "dark";
  return flipped === system ? "system" : flipped;
}

let current = saved();
apply(current);
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-theme-toggle]")) {
  b.hidden = false;
  b.addEventListener("click", () => {
    current = next(current);
    save(current);
    apply(current);
  });
}
dark.addEventListener("change", () => apply(current));

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
  if (!navigator.clipboard) continue;
  b.hidden = false;
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(b.dataset.copy ?? "");
      b.textContent = "Copied";
    } catch {
      b.textContent = "Press Ctrl+C";
    }
    setTimeout(() => {
      b.textContent = "Copy";
    }, 1800);
  });
}
