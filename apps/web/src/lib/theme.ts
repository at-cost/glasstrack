import { createStore, useStore } from "./store";

/** Every theme is a set of CSS custom properties in styles/base.css under :root[data-theme="<id>"]. */
export const THEMES = [
  { id: "light", label: "Light", mode: "light", swatch: ["#f5f2eb", "#fbf9f4", "#2f5d50", "#23211d"] },
  { id: "dark", label: "Dark", mode: "dark", swatch: ["#1b1a18", "#2a2825", "#7ab39f", "#ece7dc"] },
  { id: "snow", label: "Snow", mode: "light", swatch: ["#f4f6f9", "#ffffff", "#2d5bd2", "#16191f"] },
  { id: "midnight", label: "Midnight", mode: "dark", swatch: ["#0f141d", "#1a2130", "#7ca7ff", "#e4e9f2"] },
  { id: "contrast", label: "High contrast", mode: "light", swatch: ["#ffffff", "#ffffff", "#0b4f3f", "#000000"] },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
export type ThemeChoice = "system" | ThemeId;
const KEY = "glasstrack-theme";
const isTheme = (v: unknown): v is ThemeId => THEMES.some((t) => t.id === v);

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    if (isTheme(v)) return v;
  } catch {
    // storage blocked
  }
  return "system";
}

export const themeStore = createStore<ThemeChoice>(read());

export function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

export function setTheme(choice: ThemeChoice) {
  themeStore.set(choice);
  applyTheme(choice);
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // storage blocked
  }
}

export function effectiveTheme(choice: ThemeChoice): "light" | "dark" {
  if (choice !== "system") return THEMES.find((t) => t.id === choice)?.mode ?? "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** The sidebar switch: flips between the light and dark of the same family. */
export function toggleTheme() {
  const cur = themeStore.get();
  const pairs: Record<string, ThemeId> = { light: "dark", dark: "light", snow: "midnight", midnight: "snow", contrast: "dark" };
  if (cur !== "system") setTheme(pairs[cur] ?? "light");
  else setTheme(effectiveTheme(cur) === "dark" ? "light" : "dark");
}

export const useTheme = () => useStore(themeStore);
