// Navigation lockdown for child app windows.
//
// App pages are arbitrary user-built HTML and carry the preload IPC bridge
// (window.desktop.*). Without these guards a compromised app page could steer
// its window off-origin while still holding that bridge. Lock each child window
// to the loopback app origin: block off-origin top-level navigation, and route
// popups through the same audited handler the main window uses (external →
// system browser, never a new in-app window). The main window already had these
// guards inline; this extracts them so the child windows get the same coverage.

import { shell, type BrowserWindow, type WindowOpenHandlerResponse } from "electron";
import { getLAXConfig } from "./config";

/** True when the URL parses to the live app origin. Parsed, never a string
 *  prefix: `http://127.0.0.1:4321@evil.example/` starts with the origin but its
 *  host is evil.example (the rest is userinfo), and `http://127.0.0.1:43210`
 *  is another port. */
export function isAppOrigin(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.origin === new URL(`http://127.0.0.1:${getLAXConfig().port}`).origin;
}

export function lockAppWindowNavigation(
  win: BrowserWindow,
  onWindowOpen: (url: string) => WindowOpenHandlerResponse,
): void {
  win.webContents.on("will-navigate", (e, navUrl) => {
    if (isAppOrigin(navUrl)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(navUrl)) shell.openExternal(navUrl).catch(() => { /* best-effort */ });
  });
  win.webContents.setWindowOpenHandler(({ url }) => onWindowOpen(url));
}
