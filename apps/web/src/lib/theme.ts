import { createStore, useStore } from "./store";

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "tracker-theme";

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
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
  if (choice !== "system") return choice;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Cycles light/dark based on what is currently shown. */
export function toggleTheme() {
  setTheme(effectiveTheme(themeStore.get()) === "dark" ? "light" : "dark");
}

export const useTheme = () => useStore(themeStore);
