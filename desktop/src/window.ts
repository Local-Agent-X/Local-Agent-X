// Main BrowserWindow + child app windows. Owns mainWindow state.
//
// macOS: titleBarStyle "hiddenInset" hides the visual title bar but keeps
// a native drag region (the top ~28px) so the window stays draggable and
// the traffic-light buttons sit inside our content area. With plain
// "hidden" the user has no way to move the window short of toggling
// fullscreen.
// Windows/Linux: keep the JS-injected branded titlebar (the did-finish-
// load handler below) and use titleBarOverlay for the min/max/X buttons.

import { BrowserWindow, Menu, MenuItem, shell } from "electron";
import { join } from "path";
import { ICON_PATH, getProjectRoot, getLAXConfig } from "./config";
import { bgForTheme, overlayForTheme } from "./theme";
import { getSetting, setSetting } from "./settings";
import { buildSplashDataUrl } from "./splash";
import { isServerRunning, isQuittingFlag } from "./server-process";
import { buildAppDragStripJs } from "./window-injections";
import { lockAppWindowNavigation } from "./app-window-guards";

let mainWindow: BrowserWindow | null = null;

// ── Content zoom on the overlay-titlebar platforms (Windows/Linux) ──────────
//
// The native window-control overlay (titleBarOverlay) is sized in DEVICE
// pixels and does NOT scale when the page is content-zoomed — but the CSS that
// reserves room for it (body.platform-win { margin-top: 32px; height: calc(
// 100vh - 32px) }) DOES scale with zoom. So zooming drifted the two apart and
// pushed app content under the chrome with no way to scroll to it. We own zoom
// here — stepped + clamped — and resize the overlay by the SAME factor so the
// native controls and the CSS titlebar stay locked together at any zoom. macOS
// uses hiddenInset (no overlay) and the native menu's zoom roles, left as-is.
const BASE_TITLEBAR_PX = 32;
const ZOOM_MIN = 0.7;
const ZOOM_MAX = 1.6;
const ZOOM_STEP = 0.1;
const usesOverlayTitlebar = process.platform !== "darwin";

/** Resize the native window-control overlay to match the zoomed CSS titlebar. */
function syncTitleBarToZoom(win: BrowserWindow, factor: number): void {
  if (!usesOverlayTitlebar) return;
  try {
    win.setTitleBarOverlay({
      ...overlayForTheme(getSetting("theme")),
      height: Math.max(1, Math.round(BASE_TITLEBAR_PX * factor)),
    });
  } catch { /* window has no overlay / is gone — nothing to sync */ }
}

/** Apply a clamped content-zoom factor and keep the overlay aligned with it. */
function setMainZoom(win: BrowserWindow, factor: number): void {
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, factor));
  win.webContents.setZoomFactor(clamped);
  syncTitleBarToZoom(win, clamped);
}

/**
 * Re-apply the main window's titlebar overlay (theme colours + a height that
 * matches the CURRENT zoom). Used by the theme-change handler so flipping theme
 * while zoomed doesn't reset the overlay to its base height and re-open the
 * desync this whole block exists to prevent.
 */
export function reapplyMainTitleBarOverlay(): void {
  if (mainWindow && usesOverlayTitlebar) {
    syncTitleBarToZoom(mainWindow, mainWindow.webContents.getZoomFactor());
  }
}

// Traffic-light padding for macOS lives in public/css/app.css under the
// `body.platform-darwin` selector (set by preload.ts). Earlier attempt
// injected from here via webContents.insertCSS on did-finish-load, but
// the sheet sometimes didn't land — DevTools showed zero injected
// stylesheets after the boot. CSS shipped with the page is deterministic.

// True once the splash has handed off to the real app URL. Stays false
// for the entire time we're on the spinner / recovery screen. main.ts
// reads it via isStuckOnSplash() so a second launch can detect that
// the existing instance never made it past boot and yield to us.
let navigatedToApp = false;
let bootStartedAt = 0;

export function getMainWindow(): BrowserWindow | null { return mainWindow; }

/**
 * True when the splash has been on screen longer than `gracePeriodMs`
 * without the real app loading. Used by main.ts to decide whether a
 * concurrent shortcut click should yield (we're stuck) or focus (we're
 * just booting normally).
 */
export function isStuckOnSplash(gracePeriodMs: number): boolean {
  if (navigatedToApp) return false;
  if (bootStartedAt === 0) return false;
  return Date.now() - bootStartedAt > gracePeriodMs;
}

export function createWindow(): void {
  const bounds = getSetting("windowBounds");
  const laxConfig = getLAXConfig();

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: 600,
    minHeight: 400,
    icon: ICON_PATH,
    title: "",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    titleBarOverlay: process.platform === "darwin" ? undefined : overlayForTheme(getSetting("theme")),
    backgroundColor: bgForTheme(getSetting("theme")),
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  const url = `http://127.0.0.1:${laxConfig.port}/?token=${laxConfig.authToken}`;
  const serverOrigin = `http://127.0.0.1:${laxConfig.port}`;

  // Show the branded splash IMMEDIATELY so the user sees something the
  // moment the window appears. Poll /api/health in the background and
  // navigate to the real app the moment it answers. Replaces the previous
  // "blank window for 30+ seconds while the server boots" failure mode.
  mainWindow.loadURL(buildSplashDataUrl(getSetting("theme")));

  navigatedToApp = false;
  bootStartedAt = Date.now();
  const HEALTH_POLL_DELAY_MS = 500;

  // Poll until the server answers, however long that takes. Reconcile runs
  // BEFORE startServer (main.ts), so a slow/large build legitimately delays
  // the server by minutes; the previous fixed 120s deadline abandoned the
  // poll and froze the splash forever when the server came up after it. The
  // build is now bounded (reconcile.ts runStep timeout) so the server always
  // starts eventually, and main.ts arms a recovery watchdog so a genuinely
  // dead boot still surfaces a Repair button — this just keeps watching so a
  // late-but-healthy server always loads.
  const pollAndNavigate = async (): Promise<void> => {
    while (!navigatedToApp) {
      if (mainWindow == null || mainWindow.isDestroyed()) return;
      if (await isServerRunning()) {
        navigatedToApp = true;
        mainWindow.loadURL(url);
        return;
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_DELAY_MS));
    }
  };
  pollAndNavigate();

  // Belt-and-suspenders: did-fail-load retry. If the real-app loadURL
  // ever fails (server hiccup mid-session, sleep/wake, restart), retry
  // up to 90s instead of leaving the renderer on chrome-error.
  const LOAD_RETRY_DEADLINE_MS = 90_000;
  const LOAD_RETRY_DELAY_MS = 1_000;
  let retryPending = false;
  let retryStartedAt = 0;

  mainWindow.webContents.on("did-fail-load", (_e, errorCode, _desc, validatedURL) => {
    if (errorCode === -3) return;
    if (validatedURL && !validatedURL.startsWith(serverOrigin)) return;
    if (retryPending) return;
    if (retryStartedAt === 0) retryStartedAt = Date.now();
    if (Date.now() - retryStartedAt > LOAD_RETRY_DEADLINE_MS) {
      console.error(`[desktop] Gave up loading ${url} after ${LOAD_RETRY_DEADLINE_MS}ms — server not responding`);
      return;
    }
    retryPending = true;
    setTimeout(() => {
      retryPending = false;
      mainWindow?.loadURL(url);
    }, LOAD_RETRY_DELAY_MS);
  });

  // The in-window titlebar (Windows/Linux) ships in app.html, gated by the
  // platform-win body class the preload sets before first paint — no runtime
  // injection. macOS uses the native top-of-screen menu (app-menu.ts).
  mainWindow.webContents.on("did-finish-load", () => {
    const currentUrl = mainWindow?.webContents.getURL() ?? "";
    if (!currentUrl.startsWith(serverOrigin)) return;
    // Electron persists zoom per-origin, so one accidental Ctrl+- otherwise
    // sticks across every future boot. Pin each app load back to 100% (and
    // re-base the overlay height); the user can still zoom within a session.
    if (mainWindow) setMainZoom(mainWindow, 1);
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // Intercept navigation to document files — open with system default app.
  mainWindow.webContents.on("will-navigate", (e, navUrl) => {
    console.log(`[desktop] will-navigate: ${navUrl}`);
    const DOC_EXTENSIONS = /\.(docx?|xlsx?|pptx?|pdf|csv)$/i;
    try {
      const pathname = new URL(navUrl).pathname;
      if (DOC_EXTENSIONS.test(pathname)) {
        e.preventDefault();
        openDocByPath(pathname);
      }
    } catch { /* not a valid URL — let it navigate normally */ }
  });

  // Disable Ctrl+R / Ctrl+Shift+R / F5 (causes port/localStorage issues), and on
  // Windows/Linux own content-zoom so the overlay stays aligned (see setMainZoom).
  mainWindow.webContents.on("before-input-event", (_e, input) => {
    if (input.key === "F5" || (input.control && input.key.toLowerCase() === "r")) {
      _e.preventDefault();
      return;
    }
    if (usesOverlayTitlebar && input.type === "keyDown" && (input.control || input.meta) && mainWindow) {
      const k = input.key;
      const z = mainWindow.webContents.getZoomFactor();
      if (k === "=" || k === "+") { _e.preventDefault(); setMainZoom(mainWindow, z + ZOOM_STEP); }
      else if (k === "-" || k === "_") { _e.preventDefault(); setMainZoom(mainWindow, z - ZOOM_STEP); }
      else if (k === "0") { _e.preventDefault(); setMainZoom(mainWindow, 1); }
    }
  });

  // Ctrl+mouse-wheel zoom (Windows/Linux): clamp it and re-align the overlay.
  if (usesOverlayTitlebar) {
    mainWindow.webContents.on("zoom-changed", () => {
      if (!mainWindow) return;
      const cur = mainWindow.webContents.getZoomFactor();
      const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cur));
      if (clamped !== cur) mainWindow.webContents.setZoomFactor(clamped);
      syncTitleBarToZoom(mainWindow, clamped);
    });
  }

  // Right-click context menu. Electron's spellcheck: true gives the red
  // underline for free, but the menu (suggestions, Add to Dictionary,
  // cut/copy/paste/select-all) has to be built manually.
  mainWindow.webContents.on("context-menu", (_event, params) => {
    if (!mainWindow) return;
    const menu = new Menu();

    if (params.misspelledWord) {
      if (params.dictionarySuggestions.length > 0) {
        for (const suggestion of params.dictionarySuggestions) {
          menu.append(new MenuItem({
            label: suggestion,
            click: () => mainWindow?.webContents.replaceMisspelling(suggestion),
          }));
        }
      } else {
        menu.append(new MenuItem({ label: "No suggestions", enabled: false }));
      }
      menu.append(new MenuItem({
        label: "Add to Dictionary",
        click: () => mainWindow?.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      }));
      menu.append(new MenuItem({ type: "separator" }));
    }

    const { canCut, canCopy, canPaste, canSelectAll } = params.editFlags;
    if (canCut)       menu.append(new MenuItem({ role: "cut" }));
    if (canCopy)      menu.append(new MenuItem({ role: "copy" }));
    if (canPaste)     menu.append(new MenuItem({ role: "paste" }));
    if (canSelectAll) menu.append(new MenuItem({ role: "selectAll" }));

    if (menu.items.length > 0) {
      menu.popup({ window: mainWindow });
    }
  });

  mainWindow.on("resize", () => {
    if (mainWindow && !mainWindow.isMaximized()) {
      const [width, height] = mainWindow.getSize();
      setSetting("windowBounds", { width, height });
    }
  });

  mainWindow.on("close", (e) => {
    if (!isQuittingFlag() && getSetting("closeToTray")) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: openUrl }) => handleWindowOpen(openUrl));
}

// Resolve /files/* paths against PROJECT_ROOT, not process.cwd() — a
// Finder/Launchpad-launched .app has cwd `/`; a Windows desktop-launch.bat
// has cwd `<repo>/desktop`. Neither resolves the workspace/ path correctly.
function openDocByPath(pathname: string): void {
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

function handleWindowOpen(openUrl: string): Electron.WindowOpenHandlerResponse {
  const laxConfig = getLAXConfig();
  console.log(`[desktop] windowOpenHandler: ${openUrl}`);

  // External links → system browser
  if (openUrl.startsWith("http") && !openUrl.includes("127.0.0.1")) {
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

export function showWindow(): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

export function toggleWindow(): void {
  if (mainWindow?.isVisible() && mainWindow?.isFocused()) {
    mainWindow.hide();
  } else {
    showWindow();
  }
}
