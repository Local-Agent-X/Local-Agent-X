// JavaScript injected into BrowserWindow renderers. Kept as a plain string
// because the body runs inside the renderer's context — different `window`,
// different DOM, no access to anything in main. The main-process file calls
// webContents.executeJavaScript(STRING) on the right lifecycle event.
//
// Only the child app-window drag strip lives here: its tint is sampled from
// the (arbitrary, user-built) app's body background at runtime, which static
// CSS can't do. The main window's titlebar is the opposite — fixed LAX
// chrome — so it ships as real HTML in app.html, gated by the platform-win
// body class the preload sets, rather than being injected.

import { nativeTheme } from "electron";
import type { DesktopSettings } from "./settings";

// Drag strip injected into child app windows.
//
// Windows/Linux: the native min/max/X controls live in a titleBarOverlay
// painted over the top-right, so the app needs a real top bar to host them.
// The strip reads the app's effective body background, paints itself with
// it, reports the hex back to main so the overlay matches (killing the
// LAX-theme-strip-over-app-content seam), and reserves 32px of body padding
// so app content doesn't slide under the bar. Extends to right:0 so the
// overlay has no dark sliver beside it.
//
// macOS: the window controls are the native traffic lights, which simply
// float over the top-left corner — there is no menu or overlay that needs
// to live in a bar. So an opaque strip here is pure overhead that visually
// covers the app and shoves its content down. Instead we lay down a
// transparent, full-width drag region (so the frameless window stays
// draggable from its top edge) and add NO body padding: the app fills the
// window and the traffic lights float over its content, the way a native
// mac app looks.
export function buildAppDragStripJs(theme: DesktopSettings["theme"]): string {
  const isMac = process.platform === "darwin";
  const reserveRight = 0;
  const isDark = theme === "dark" || (theme === "system" && nativeTheme.shouldUseDarkColors);
  const fallbackBg = isDark ? "#0a0a0f" : "#ffffff";

  if (isMac) {
    // Invisible drag region only — no tint, no padding, no overlay report.
    return `
    (() => {
      if (document.getElementById('__lax_drag_strip')) return;
      const bar = document.createElement('div');
      bar.id = '__lax_drag_strip';
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:32px;z-index:2147483647;background:transparent;-webkit-app-region:drag;pointer-events:auto;';
      document.body.appendChild(bar);
    })();
  `;
  }

  return `
    (() => {
      if (document.getElementById('__lax_drag_strip')) return;

      function readBg(el) {
        const c = getComputedStyle(el).backgroundColor;
        return (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') ? c : null;
      }
      const tint = readBg(document.body) || readBg(document.documentElement) || '${fallbackBg}';
      const m = String(tint).match(/rgba?\\((\\d+)[,\\s]+(\\d+)[,\\s]+(\\d+)/);
      let isDarkTint = false;
      let hexTint = tint;
      if (m) {
        const r = +m[1], g = +m[2], b = +m[3];
        isDarkTint = (0.299*r + 0.587*g + 0.114*b) / 255 < 0.5;
        const toHex = (v) => ('0' + (+v).toString(16)).slice(-2);
        hexTint = '#' + toHex(r) + toHex(g) + toHex(b);
      } else {
        isDarkTint = ${isDark ? "true" : "false"};
      }
      const symbolColor = isDarkTint ? '#e0e0e8' : '#1a1a2e';

      const bar = document.createElement('div');
      bar.id = '__lax_drag_strip';
      bar.style.cssText = 'position:fixed;top:0;left:0;right:${reserveRight}px;height:32px;z-index:2147483647;background:' + tint + ';-webkit-app-region:drag;pointer-events:auto;';
      document.body.appendChild(bar);

      if (window.desktop && window.desktop.reportChromeTint) {
        try { window.desktop.reportChromeTint(hexTint, symbolColor); } catch (e) {}
      }
      const cs = getComputedStyle(document.body);
      const cur = parseInt(cs.paddingTop) || 0;
      if (cur < 32) document.body.style.paddingTop = (cur + 32) + 'px';
    })();
  `;
}
