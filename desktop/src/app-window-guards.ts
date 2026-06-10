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

export function lockAppWindowNavigation(
  win: BrowserWindow,
  onWindowOpen: (url: string) => WindowOpenHandlerResponse,
): void {
  win.webContents.on("will-navigate", (e, navUrl) => {
    const appOrigin = `http://127.0.0.1:${getLAXConfig().port}`;
    if (!navUrl.startsWith(appOrigin)) {
      e.preventDefault();
      if (/^https?:\/\//i.test(navUrl)) shell.openExternal(navUrl).catch(() => { /* best-effort */ });
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => onWindowOpen(url));
}
