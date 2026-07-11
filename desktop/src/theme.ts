// Theme color resolution for the Electron-side chrome (window background,
// Windows titleBarOverlay, OS chrome theme source). Renderer holds the
// HTML/CSS theme; this is the Electron half so the OS chrome matches.

import { nativeTheme } from "electron";
import type { DesktopSettings } from "./settings";

// Paint colour for the BrowserWindow underneath the HTML. Visible behind
// the macOS traffic-light strip when the title bar is hidden, and as the
// initial fill before HTML loads.
export function bgForTheme(theme: DesktopSettings["theme"]): string {
  if (theme === "light") return "#f5f5f7";
  if (theme === "system") return nativeTheme.shouldUseDarkColors ? "#0a0a0f" : "#f5f5f7";
  return "#0a0a0f";
}

// Windows titleBarOverlay control colors. Native widget, can't use CSS vars.
// BOOT-PHASE FALLBACK ONLY: once the renderer loads it reports its computed
// --surface via report-chrome-tint, which owns the overlay color from then on
// (window.ts caches it and every zoom/theme re-sync repaints with it). So this
// only needs to blend with what's on screen BEFORE that report — the splash /
// window background, both painted from bgForTheme. Deriving from bgForTheme
// keeps the corner matched during boot by construction.
export function overlayForTheme(theme: DesktopSettings["theme"]): { color: string; symbolColor: string; height: number } {
  const isDark = theme === "dark" || (theme === "system" && nativeTheme.shouldUseDarkColors);
  return {
    color: bgForTheme(theme),
    symbolColor: isDark ? "#40f0f0" : "#1a1a2e",
    height: 32,
  };
}

// Tells Windows itself which theme our app prefers. Without this set,
// Windows paints the titleBarOverlay using the OS-level setting on first
// frame — before Electron applies our titleBarOverlay config. Symptom:
// the X/min/max strip paints white briefly until a theme toggle "wakes
// up" the overlay. Setting nativeTheme.themeSource forces Windows into
// our palette at the OS chrome level so the first paint is correct.
export function applyNativeTheme(theme: DesktopSettings["theme"]): void {
  nativeTheme.themeSource = theme === "light" ? "light" : theme === "dark" ? "dark" : "system";
}
