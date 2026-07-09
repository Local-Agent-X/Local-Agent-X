// Window-open routing for the MAIN window's popups. /apps/<id> links open in the
// system browser (handleWindowOpen → openAppExternally): a user-built app is a
// real web app, and a browser tab gives it devtools, real navigation, and a
// static-build app that runs with no dev server. The one in-app popup that
// remains is the account window (device-code login + phone pairing), which must
// stay on our origin. Split out of window.ts (which owns the MAIN window) to keep
// each file one responsibility; the main window wires handleWindowOpen into its
// setWindowOpenHandler / will-navigate.

import { BrowserWindow, shell } from "electron";
import { join } from "path";
import { ICON_PATH, getProjectRoot, getLAXConfig } from "./config";
import { bgForTheme, overlayForTheme } from "./theme";
import { getSetting } from "./settings";
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

  // Local app links (/apps/xyz) → the system browser, not a frameless in-app
  // window. A user-built app is a real web app; opening it as a browser tab
  // gives it devtools, real navigation, and a shareable loopback URL, and lets
  // a static-build app run with no dev server behind it. The operator token is
  // appended so the loopback auth gate admits it; the served page strips it from
  // the address bar (history.replaceState) on load.
  if (openUrl.startsWith(appOrigin)) {
    openAppExternally(openUrl);
    return { action: "deny" };
  }
  return { action: "deny" };
}

/** Open a loopback /apps/<id> URL in the user's default browser, appending the
 *  operator token so the same-origin auth gate admits the request. Only ever
 *  called with our own server origin (handleWindowOpen gates on appOrigin), so
 *  the token is never leaked to an arbitrary host. */
function openAppExternally(targetUrl: string): void {
  const laxConfig = getLAXConfig();
  const separator = targetUrl.includes("?") ? "&" : "?";
  shell.openExternal(`${targetUrl}${separator}token=${laxConfig.authToken}`);
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

