// The main BrowserWindow: creation, splash→app handoff, content zoom, and the
// window-level handlers. Owns mainWindow state. Child "app" windows (the
// /apps/<id> frameless windows + warm pool) live in app-windows.ts.
//
// macOS: titleBarStyle "hiddenInset" hides the visual title bar but keeps
// a native drag region (the top ~28px) so the window stays draggable and
// the traffic-light buttons sit inside our content area. With plain
// "hidden" the user has no way to move the window short of toggling
// fullscreen.
// Windows/Linux: keep the JS-injected branded titlebar (the did-finish-
// load handler below) and use titleBarOverlay for the min/max/X buttons.

import { BrowserWindow, Menu, MenuItem } from "electron";
import { join } from "path";
import { ICON_PATH, getLAXConfig } from "./config";
import { bgForTheme, overlayForTheme } from "./theme";
import { getSetting, setSetting } from "./settings";
import { buildSplashDataUrl } from "./splash";
import { isServerRunning, isQuittingFlag } from "./server-process";
import { handleWindowOpen, openDocByPath, prewarmAppWindow, openAccountWindow } from "./app-windows";

// Child app windows (the /apps/<id> frameless windows + warm pool) live in
// app-windows.ts; re-exported so main.ts's existing import path is unchanged.
export { prewarmAppWindow, openAccountWindow };

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

/** Step the main window's content zoom through the SAME clamped, overlay-aware
 *  path as the Ctrl +/-/0 shortcuts. The Windows in-window menu routes here (via
 *  ipc → preload) instead of doing its own document.body.style.zoom, so the two
 *  can't compound past ZOOM_MAX or drift the native window-control overlay. */
export function stepMainZoom(dir: "in" | "out" | "reset"): void {
  if (!mainWindow) return;
  if (dir === "reset") { setMainZoom(mainWindow, 1); return; }
  const z = mainWindow.webContents.getZoomFactor();
  setMainZoom(mainWindow, z + (dir === "in" ? ZOOM_STEP : -ZOOM_STEP));
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
    // Windows/Linux carry a hidden accelerator-only menu (app-menu.ts) so the
    // in-window titlebar's shortcuts (Ctrl+R, Ctrl+Shift+A/I, …) actually bind.
    // autoHideMenuBar keeps that menu bar invisible — only the custom titlebar
    // shows — while its accelerators stay live. Harmless on macOS (native menu).
    autoHideMenuBar: true,
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
    // F5 = raw hard-refresh with no safe handler → still blocked (re-fetches the
    // app URL and dies if the server port rotated). Ctrl+R is NO LONGER swallowed
    // here: app-menu.ts binds it to a SAFE reload (re-navigate the live tokenized
    // URL) so the shortcut works without the port/localStorage breakage. Blocking
    // it here would preventDefault before that accelerator ever fires.
    if (input.key === "F5") {
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
