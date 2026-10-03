// Window-open routing for the MAIN window's popups and navigations, and the
// in-app windows that routing opens. /apps/<id> links open in the system
// browser (handleWindowOpen → openAppExternally): a user-built app is a real
// web app, and a browser tab gives it devtools, real navigation, and a
// static-build app that runs with no dev server. /files/ pages open in an
// in-app window, and the account window (device-code login + phone pairing)
// stays on our origin. Split out of window.ts (which owns the MAIN window) to
// keep each file one responsibility; the main window wires handleWindowOpen
// into its setWindowOpenHandler / will-navigate.

import { BrowserWindow, shell } from "electron";
import { join } from "path";
import { ICON_PATH, getLAXConfig } from "./config";
import { openProjectFile } from "./open-project-file";
import { bgForTheme, overlayForTheme } from "./theme";
import { getSetting } from "./settings";
import { buildAppDragStripJs } from "./window-injections";
import { lockAppWindowNavigation } from "./app-window-guards";
import { isExternalBrowserUrl } from "./url-classify";
import { getMainWindow } from "./window";

const DOC_EXTENSIONS = /\.(docx?|xlsx?|pptx?|pdf|csv)$/i;
const AGENT_APP_PATH = /^\/(apps|dashboards)\//;

function appOrigin(): string {
  return `http://127.0.0.1:${getLAXConfig().port}`;
}

function parseUrl(url: string): URL | null {
  try { return new URL(url); } catch { return null; }
}

/** True only for the app shell on the live server origin: the one document
 *  allowed to hold the preload bridge. Every place the desktop loads the UI
 *  builds `/?token=`. An unparseable URL is not the shell, so a caller that
 *  blocks everything else fails closed. */
export function isAppShellUrl(url: string): boolean {
  const parsed = parseUrl(url);
  return parsed?.origin === appOrigin() && parsed.pathname === "/";
}

// The query carries the operator token on our own links and OAuth codes on
// external ones, and these lines land in desktop-stdio.log.
function loggableUrl(url: URL): string {
  const copy = new URL(url.href);
  copy.username = "";
  copy.password = "";
  copy.search = "";
  copy.hash = "";
  return copy.href;
}

// The extension test runs on the still-encoded pathname, so `run.exe%00.pdf`
// passes it; openProjectFile is what stops the decoded path from reaching
// ShellExecute, which would truncate it at the NUL and run run.exe.
function openDocByPath(pathname: string): void {
  const relativePath = pathname.startsWith("/files/")
    ? join("workspace", decodeURIComponent(pathname.slice(7)))
    : decodeURIComponent(pathname.slice(1));
  openProjectFile(relativePath).then((err) => {
    if (err) console.warn(`[desktop] Failed to open ${JSON.stringify(relativePath)}: ${err}`);
  });
}

export function handleWindowOpen(openUrl: string): Electron.WindowOpenHandlerResponse {
  const target = parseUrl(openUrl);
  console.log(`[desktop] windowOpenHandler: ${target ? loggableUrl(target) : "(unparseable url)"}`);

  // External links → system browser. isExternalBrowserUrl classifies by hostname
  // (not a substring) so an OAuth URL carrying a 127.0.0.1 redirect_uri in its
  // query still opens externally — the bug that kept xAI sign-in from opening.
  if (isExternalBrowserUrl(openUrl)) {
    shell.openExternal(openUrl);
    return { action: "deny" };
  }

  // A pinned or previewed app opening one of its own pages. Apps are served
  // from the server's agent origin, a loopback port this process is not told,
  // so the page is recognised by its path; like an /apps link from the shell
  // (below) it goes to the system browser, which holds nothing of ours.
  if (target && target.protocol === "http:" && target.hostname === "127.0.0.1" && target.origin !== appOrigin() && AGENT_APP_PATH.test(target.pathname)) {
    shell.openExternal(target.href);
    return { action: "deny" };
  }

  // Origin equality, not a string prefix: `http://127.0.0.1:4321` is also a
  // prefix of port 43210, a listener that is not ours.
  if (target?.origin !== appOrigin()) return { action: "deny" };

  if (DOC_EXTENSIONS.test(target.pathname)) {
    openDocByPath(target.pathname);
    return { action: "deny" };
  }

  // /files/ pages are agent-written. Main opens them in its own window rather
  // than allowing Chromium's popup: a popup keeps window.opener, the main
  // window, which the page could navigate through it whatever the popup's own
  // preferences. The UI origin redirects the window to the agent origin.
  if (target.pathname.startsWith("/files/")) {
    openFilesWindow(openUrl);
    return { action: "deny" };
  }

  // Local app links (/apps/xyz) → the system browser, not a frameless in-app
  // window. A user-built app is a real web app; opening it as a browser tab
  // gives it devtools, real navigation, and a shareable loopback URL, and lets
  // a static-build app run with no dev server behind it. The server redirects
  // it to the agent origin, which needs no token, so none is added: the
  // operator token never reaches the browser's history or an agent page.
  shell.openExternal(openUrl);
  return { action: "deny" };
}

// Every in-app window opened here. None gets the preload: window.desktop
// reaches the terminal PTY, open-file and settings IPC, and the main window
// (window.ts), held to the app shell, is the only one that may carry it.
// Popups come back through handleWindowOpen.
function buildBridgelessWindow(chrome: Electron.BrowserWindowConstructorOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    icon: ICON_PATH,
    backgroundColor: bgForTheme(getSetting("theme")),
    ...chrome,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  lockAppWindowNavigation(win, handleWindowOpen);
  return win;
}

function openFilesWindow(url: string): void {
  const win = buildBridgelessWindow({ autoHideMenuBar: true });
  // A page that navigates before it finishes loading aborts this load; the
  // window then shows the page it navigated to, so there is nothing to report.
  win.loadURL(url).catch(() => {});
}

/** Open the agentxos account page (device-code login + phone pairing) in an in-app
 *  window. Popups (the external "approval page" link) route to the default
 *  browser via handleWindowOpen — so the token stays in-app, not in the system
 *  browser's history. */
export function openAccountWindow(): void {
  const laxConfig = getLAXConfig();
  const win = buildBridgelessWindow({
    frame: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    titleBarOverlay: process.platform === "darwin" ? undefined : overlayForTheme(getSetting("theme")),
  });
  // Glue the popup to the main window: a CHILD window stays above its parent and is
  // raised with it — clicking the LAX dock icon brings the popup forward too — and it
  // needs no dock icon of its own. Fixes "it gets buried behind LAX and I have to
  // minimize LAX to find it." setParentWindow (not the ctor) so buildBridgelessWindow stays shared.
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
  appWin.webContents.on("did-finish-load", () => {
    const currentUrl = appWin.webContents.getURL() || "";
    if (!currentUrl.startsWith(appOrigin()) || currentUrl.includes("/api/health")) return;
    const js = buildAppDragStripJs(getSetting("theme"));
    appWin.webContents.executeJavaScript(js).catch(() => { /* page unloaded */ });
    // On macOS the injected strip is a transparent drag region with no
    // body padding, so the app fills the window and the native traffic
    // lights float over its top-left corner — no bar covering the app.
    // On Windows/Linux the strip is opaque and reserves 32px so content
    // clears the titleBarOverlay window controls.
  });
}
