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
import { ICON_PATH, getProjectRoot, getSAXConfig } from "./config";
import { bgForTheme, overlayForTheme } from "./theme";
import { getSetting, setSetting } from "./settings";
import { buildSplashDataUrl } from "./splash";
import { isServerRunning, isQuittingFlag } from "./server-process";
import { MAIN_WINDOW_TITLEBAR_JS, buildAppDragStripJs } from "./window-injections";

let mainWindow: BrowserWindow | null = null;

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
  const saxConfig = getSAXConfig();

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

  const url = `http://127.0.0.1:${saxConfig.port}/?token=${saxConfig.authToken}`;
  const serverOrigin = `http://127.0.0.1:${saxConfig.port}`;

  // Show the branded splash IMMEDIATELY so the user sees something the
  // moment the window appears. Poll /api/health in the background and
  // navigate to the real app the moment it answers. Replaces the previous
  // "blank window for 30+ seconds while the server boots" failure mode.
  mainWindow.loadURL(buildSplashDataUrl(getSetting("theme")));

  navigatedToApp = false;
  bootStartedAt = Date.now();
  const HEALTH_POLL_DEADLINE_MS = 120_000;
  const HEALTH_POLL_DELAY_MS = 500;
  const navStartedAt = bootStartedAt;

  const pollAndNavigate = async (): Promise<void> => {
    while (!navigatedToApp && Date.now() - navStartedAt < HEALTH_POLL_DEADLINE_MS) {
      if (mainWindow == null || mainWindow.isDestroyed()) return;
      if (await isServerRunning()) {
        navigatedToApp = true;
        mainWindow.loadURL(url);
        return;
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_DELAY_MS));
    }
    if (!navigatedToApp) {
      console.error(`[desktop] Server didn't respond within ${HEALTH_POLL_DEADLINE_MS}ms — splash stays.`);
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

  // Inject the custom title bar menu into the page (Windows/Linux only).
  // Skip on macOS — the native menu bar at the top of the screen already
  // covers these actions, and the native window chrome already supplies
  // traffic lights.
  // Inject the custom title bar menu (Windows/Linux only). On macOS the
  // native top-of-screen menu + the traffic-light padding (handled in
  // app.css via the platform-darwin body class set by preload) cover it.
  mainWindow.webContents.on("did-finish-load", () => {
    if (process.platform === "darwin") return;
    const currentUrl = mainWindow?.webContents.getURL() ?? "";
    if (!currentUrl.startsWith(serverOrigin)) return;
    mainWindow?.webContents.executeJavaScript(MAIN_WINDOW_TITLEBAR_JS);
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

  // Disable Ctrl+R / Ctrl+Shift+R / F5 (causes port/localStorage issues).
  mainWindow.webContents.on("before-input-event", (_e, input) => {
    if (input.key === "F5" || (input.control && input.key.toLowerCase() === "r")) {
      _e.preventDefault();
    }
  });

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
  const saxConfig = getSAXConfig();
  console.log(`[desktop] windowOpenHandler: ${openUrl}`);

  // External links → system browser
  if (openUrl.startsWith("http") && !openUrl.includes("127.0.0.1")) {
    shell.openExternal(openUrl);
    return { action: "deny" };
  }

  const appOrigin = `http://127.0.0.1:${saxConfig.port}`;
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
  return new BrowserWindow({
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
}

// Inject the draggable strip on every page load. App pages are arbitrary
// user-built HTML — the strip samples the app's bg and reports it back
// for the OS overlay so both halves of the top 32px share one color.
// Skipped on the warm-up URL (/api/health) since that's not a real app page.
function attachAppDragStrip(appWin: BrowserWindow): void {
  const saxConfig = getSAXConfig();
  const appOrigin = `http://127.0.0.1:${saxConfig.port}`;
  appWin.webContents.on("did-finish-load", () => {
    const currentUrl = appWin.webContents.getURL() || "";
    if (!currentUrl.startsWith(appOrigin) || currentUrl.includes("/api/health")) return;
    const js = buildAppDragStripJs(getSetting("theme"));
    appWin.webContents.executeJavaScript(js).catch(() => { /* page unloaded */ });
    // macOS traffic-light padding is handled by app.css via the
    // platform-darwin body class set in preload.ts — applies to
    // any window that loads the preload, this one included.
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
      const saxConfig = getSAXConfig();
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
      w.loadURL(`http://127.0.0.1:${saxConfig.port}/api/health?token=${saxConfig.authToken}`);
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
  const saxConfig = getSAXConfig();
  const separator = targetUrl.includes("?") ? "&" : "?";
  const fullUrl = `${targetUrl}${separator}token=${saxConfig.authToken}`;

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
