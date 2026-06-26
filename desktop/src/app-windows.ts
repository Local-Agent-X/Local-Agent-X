// Child "app" windows — the frameless Electron windows that host a user-built
// app (/apps/<id>) with the preload bridge, plus the warm-window pool that makes
// pinned-app clicks feel instant. Split out of window.ts (which owns the MAIN
// window) to keep each file one responsibility. The main window wires
// handleWindowOpen into its setWindowOpenHandler / will-navigate; main.ts calls
// prewarmAppWindow once the server is up.

import { BrowserWindow, shell } from "electron";
import { join } from "path";
import { ICON_PATH, getProjectRoot, getLAXConfig } from "./config";
import { bgForTheme, overlayForTheme } from "./theme";
import { getSetting } from "./settings";
import { isServerRunning } from "./server-process";
import { buildAppDragStripJs } from "./window-injections";
import { lockAppWindowNavigation } from "./app-window-guards";
import { isExternalBrowserUrl } from "./url-classify";
import { getMainWindow } from "./window";

// Resolve /files/* paths against PROJECT_ROOT, not process.cwd() — a
// Finder/Launchpad-launched .app has cwd `/`; a Windows desktop-launch.bat
// has cwd `<repo>/desktop`. Neither resolves the workspace/ path correctly.
export function openDocByPath(pathname: string): void {
  const root = getProjectRoot();
  if (!root) {
    console.warn(`[desktop] openDocByPath(${pathname}) ignored — PROJECT_ROOT unresolved`);
    return;
  }
  const relativePath = pathname.startsWith("/files/")
    ? join("workspace", decodeURIComponent(pathname.slice(7)))
    : decodeURIComponent(pathname.slice(1));
  const filePath = join(root, relativePath);
  shell.openPath(filePath).then((err) => {
    if (err) console.warn(`[desktop] Failed to open ${filePath}: ${err}`);
  });
}

export function handleWindowOpen(openUrl: string): Electron.WindowOpenHandlerResponse {
  const laxConfig = getLAXConfig();
  console.log(`[desktop] windowOpenHandler: ${openUrl}`);

  // External links → system browser. isExternalBrowserUrl classifies by hostname
  // (not a substring) so an OAuth URL carrying a 127.0.0.1 redirect_uri in its
  // query still opens externally — the bug that kept xAI sign-in from opening.
  if (isExternalBrowserUrl(openUrl)) {
    shell.openExternal(openUrl);
    return { action: "deny" };
  }

  const appOrigin = `http://127.0.0.1:${laxConfig.port}`;
  if (openUrl.startsWith(appOrigin)) {
    const pathname = new URL(openUrl).pathname;
    const DOC_EXTENSIONS = /\.(docx?|xlsx?|pptx?|pdf|csv)$/i;

    if (DOC_EXTENSIONS.test(pathname)) {
      openDocByPath(pathname);
      return { action: "deny" };
    }

    if (pathname.startsWith("/files/")) {
      return { action: "allow" };
    }
  }

  // Local app links (/apps/xyz) → frameless Electron window with auth.
  // Only attach token to our own server origin, not arbitrary loopback.
  if (openUrl.startsWith(appOrigin)) {
    openAppWindow(openUrl);
    return { action: "deny" };
  }
  return { action: "deny" };
}

function buildAppWindow(hidden: boolean): BrowserWindow {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    icon: ICON_PATH,
    backgroundColor: bgForTheme(getSetting("theme")),
    frame: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    titleBarOverlay: process.platform === "darwin" ? undefined : overlayForTheme(getSetting("theme")),
    show: !hidden,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Lock child app windows to the loopback origin + route popups externally
  // (they run arbitrary user HTML with the preload bridge). See app-window-guards.
  lockAppWindowNavigation(win, handleWindowOpen);
  return win;
}

/** Open the agentxos account page (device-code login + phone pairing) in an in-app
 *  window. Reuses the app-window shell: loopback-origin locked, and popups (the
 *  external "approval page" link) route to the default browser via handleWindowOpen —
 *  so the token stays in-app, not in the system browser's history. */
export function openAccountWindow(): void {
  const laxConfig = getLAXConfig();
  const win = buildAppWindow(false);
  // Glue the popup to the main window: a CHILD window stays above its parent and is
  // raised with it — clicking the LAX dock icon brings the popup forward too — and it
  // needs no dock icon of its own. Fixes "it gets buried behind LAX and I have to
  // minimize LAX to find it." setParentWindow (not the ctor) so buildAppWindow stays shared.
  const parent = getMainWindow();
  if (parent && !parent.isDestroyed()) win.setParentWindow(parent);
  // It's real HTML on our origin, so give it the same draggable top strip the app
  // windows get — openAccountWindow previously skipped this, so the window had no
  // titlebar region to drag.
  attachAppDragStrip(win);
  win.loadURL(`http://127.0.0.1:${laxConfig.port}/account.html?token=${laxConfig.authToken}`);
}

// Inject the draggable strip on every page load. App pages are arbitrary
// user-built HTML — the strip samples the app's bg and reports it back
// for the OS overlay so both halves of the top 32px share one color.
// Skipped on the warm-up URL (/api/health) since that's not a real app page.
function attachAppDragStrip(appWin: BrowserWindow): void {
  const laxConfig = getLAXConfig();
  const appOrigin = `http://127.0.0.1:${laxConfig.port}`;
  appWin.webContents.on("did-finish-load", () => {
    const currentUrl = appWin.webContents.getURL() || "";
    if (!currentUrl.startsWith(appOrigin) || currentUrl.includes("/api/health")) return;
    const js = buildAppDragStripJs(getSetting("theme"));
    appWin.webContents.executeJavaScript(js).catch(() => { /* page unloaded */ });
    // On macOS the injected strip is a transparent drag region with no
    // body padding, so the app fills the window and the native traffic
    // lights float over its top-left corner — no bar covering the app.
    // On Windows/Linux the strip is opaque and reserves 32px so content
    // clears the titleBarOverlay window controls.
  });
}

// ── Warm app-window pool ───────────────────────────────────
// Pinned-app clicks felt sluggish at startup because every click cold-spawned
// a renderer + preload + GPU attach (~150-300ms before paint). Keep one
// hidden window pre-loaded to a cheap same-origin URL (/api/health) so the
// next openAppWindow() reuses that renderer process — /apps/<id> nav stays
// in-process and shows near-instant. Replenished in the background after
// each consume.
let warmAppWindow: BrowserWindow | null = null;
let warmingScheduled = false;

export function prewarmAppWindow(): void {
  if (warmAppWindow || warmingScheduled) return;
  warmingScheduled = true;
  const tryWarm = (): void => {
    isServerRunning().then((up) => {
      if (!up) { setTimeout(tryWarm, 2000); return; }
      const laxConfig = getLAXConfig();
      const w = buildAppWindow(true);
      attachAppDragStrip(w);
      w.webContents.once("did-finish-load", () => {
        if (w.isDestroyed()) { warmingScheduled = false; return; }
        warmAppWindow = w;
        warmingScheduled = false;
      });
      w.webContents.once("did-fail-load", (_e, errorCode) => {
        if (errorCode === -3) return; // navigation aborted (consume swapped URLs)
        warmingScheduled = false;
        if (!w.isDestroyed()) w.destroy();
      });
      w.loadURL(`http://127.0.0.1:${laxConfig.port}/api/health?token=${laxConfig.authToken}`);
    }).catch(() => setTimeout(tryWarm, 2000));
  };
  tryWarm();
}

function consumeWarmAppWindow(): BrowserWindow | null {
  const w = warmAppWindow;
  warmAppWindow = null;
  setTimeout(prewarmAppWindow, 0);
  return w && !w.isDestroyed() ? w : null;
}

function openAppWindow(targetUrl: string): void {
  const laxConfig = getLAXConfig();
  const separator = targetUrl.includes("?") ? "&" : "?";
  const fullUrl = `${targetUrl}${separator}token=${laxConfig.authToken}`;

  const warm = consumeWarmAppWindow();
  if (warm) {
    warm.loadURL(fullUrl);
    warm.show();
    return;
  }

  const appWin = buildAppWindow(false);
  attachAppDragStrip(appWin);
  appWin.loadURL(fullUrl);
}
