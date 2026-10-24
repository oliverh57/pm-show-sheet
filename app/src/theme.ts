// Light / dark mode. The choice is per Mac (localStorage); "system" follows macOS. The resolved theme goes
// on <html data-theme> for App.css, and onto the window so the title bar matches.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { create } from "zustand";

export type ThemePref = "system" | "light" | "dark";

const KEY = "pm.theme";
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const dark = window.matchMedia("(prefers-color-scheme: dark)");

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export const useTheme = create<{ pref: ThemePref }>(() => ({ pref: readPref() }));

export function setThemePref(pref: ThemePref) {
  try { localStorage.setItem(KEY, pref); } catch { /* storage unavailable */ }
  useTheme.setState({ pref });
  apply();
}

function apply() {
  const { pref } = useTheme.getState();
  // Tell the window first: with "system" it follows macOS, and the webview's prefers-color-scheme follows the window.
  if (isTauri) getCurrentWindow().setTheme(pref === "system" ? null : pref).catch(() => {});
  document.documentElement.dataset.theme = pref === "system" ? (dark.matches ? "dark" : "light") : pref;
}

/** Call once before the first render, so the page never flashes the wrong theme. */
export function initTheme() {
  apply();
  dark.addEventListener("change", () => { if (useTheme.getState().pref === "system") apply(); });
}
