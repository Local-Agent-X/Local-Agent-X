// Theme color resolution for the Electron-side chrome (window background,
// Windows titleBarOverlay, OS chrome theme source). Renderer holds the
// HTML/CSS theme; this is the Electron half so the OS chrome matches.

import { nativeTheme } from "electron";
import type { DesktopSettings } from "./settings";

// Paint colour for the BrowserWindow underneath the HTML. Visible behind
// the macOS traffic-light strip when the title bar is hidden, and as the
// initial fill before HTML loads.
export function bgForTheme(theme: DesktopSettings["theme"]): string {
  if (theme === "light") return "#ffffff";
  if (theme === "system") return nativeTheme.shouldUseDarkColors ? "#0a0a0f" : "#ffffff";
  return "#0a0a0f";
}

// Windows titleBarOverlay control colors. Native widget, can't use CSS vars,
// so we resolve to concrete hex per theme and call setTitleBarOverlay
// whenever the renderer's theme changes. Without this the min/max/X strip
// stays dark even in light mode.
export function overlayForTheme(theme: DesktopSettings["theme"]): { color: string; symbolColor: string; height: number } {
  const isDark = theme === "dark" || (theme === "system" && nativeTheme.shouldUseDarkColors);
  return isDark
    ? { color: "#0a0a0f", symbolColor: "#40f0f0", height: 32 }
    : { color: "#ffffff", symbolColor: "#1a1a2e", height: 32 };
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
