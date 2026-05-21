/**
 * Local Agent X — Electron Main Process
 *
 * Entry point. Sets Chromium flags before app.ready, then wires the
 * extracted modules together in the ready handler. Implementation lives
 * in adjacent files (config, settings, theme, server-process, window,
 * app-menu, hotkey-notifications, ipc, tray, autostart).
 */

import { app, globalShortcut } from "electron";
import { join } from "path";

import { loadSAXConfig, reloadSAXConfig, getSAXConfig, ICON_PATH } from "./config";
import { getSetting } from "./settings";
import { applyNativeTheme } from "./theme";
import {
  reclaimOrphanServer,
  isServerRunning,
  startServer,
  stopServer,
  waitForServer,
  setQuitting,
  setRestarting,
} from "./server-process";
import { createWindow, getMainWindow, showWindow, toggleWindow } from "./window";
import { setupApplicationMenu } from "./app-menu";
import { registerHotkey, showNotification } from "./hotkey-notifications";
import { setupIPC } from "./ipc";
import { createTray, destroyTray } from "./tray";
import { registerAutostart } from "./autostart";

// ── Chromium flags (must be set before app.ready) ─────────
// Only mark our own server origin as secure — not every loopback port.
// The port is in ~/.lax/config.json, but Chromium flags must be set
// before app.ready, so read the config file early here.
const _earlyPort = (() => {
  try {
    const f = require("fs");
    const p = require("path");
    const c = p.join(require("os").homedir(), ".lax", "config.json");
    if (f.existsSync(c)) return JSON.parse(f.readFileSync(c, "utf-8")).port || 7007;
  } catch {}
  return 7007;
})();
app.commandLine.appendSwitch("unsafely-treat-insecure-origin-as-secure", `http://127.0.0.1:${_earlyPort}`);
app.commandLine.appendSwitch("enable-features", "WebRTCPipeWireCapturer");
app.commandLine.appendSwitch("enable-media-stream");
// permission-request handler in app.ready controls media grants explicitly.

app.on("ready", async () => {
  loadSAXConfig();

  // Sync Windows' own chrome theme to our renderer's theme BEFORE the
  // window opens. Otherwise Windows paints the titleBarOverlay strip in
  // the system theme on first frame, producing a brief wrong-color flash
  // that some users see as a permanent mismatch until they toggle theme
  // manually (which calls setTitleBarOverlay and forces a repaint).
  applyNativeTheme(getSetting("theme"));

  setupApplicationMenu(getMainWindow);

  // Grant only the permissions the app actually needs — not a blanket allow.
  const { session } = require("electron");
  const ALLOWED_PERMISSIONS = new Set([
    "media",
    "mediaKeySystem",
    "notifications",
    "clipboard-read",
    "clipboard-sanitized-write",
  ]);
  const APP_ORIGIN = `http://127.0.0.1:${getSAXConfig().port}`;

  // Auto-open downloaded document files instead of just saving them.
  session.defaultSession.on("will-download", (_event: unknown, item: Electron.DownloadItem) => {
    const filename = item.getFilename();
    const DOC_EXTENSIONS = /\.(docx?|xlsx?|pptx?|pdf|csv)$/i;
    if (!DOC_EXTENSIONS.test(filename)) return;
    const savePath = join(require("os").tmpdir(), filename);
    item.setSavePath(savePath);
    item.once("done", (_e: unknown, state: string) => {
      if (state === "completed") {
        console.log(`[desktop] Opening downloaded file: ${savePath}`);
        require("electron").shell.openPath(savePath);
      }
    });
  });

  session.defaultSession.setPermissionRequestHandler(
    (webContents: Electron.WebContents, permission: string, callback: (granted: boolean) => void) => {
      const requestOrigin = webContents?.getURL?.() || "";
      if (requestOrigin.startsWith(APP_ORIGIN) && ALLOWED_PERMISSIONS.has(permission)) {
        callback(true);
      } else {
        console.warn(`[desktop] Denied permission "${permission}" for ${requestOrigin}`);
        callback(false);
      }
    },
  );
  session.defaultSession.setPermissionCheckHandler(
    (_wc: unknown, permission: string, requestingOrigin: string) =>
      requestingOrigin.startsWith(APP_ORIGIN) && ALLOWED_PERMISSIONS.has(permission),
  );

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  app.on("second-instance", () => showWindow());

  setupIPC();

  // Orphan-proof launch. Previously: probe port, attach if anything
  // answered — silently bound us to stale servers running pre-update
  // code. Now: pidfile handshake detects orphans (live PID whose
  // parentPid isn't us), kills them, then spawns fresh.
  const killedOrphan = await reclaimOrphanServer();
  const alreadyRunning = !killedOrphan && (await isServerRunning());
  if (!alreadyRunning) {
    startServer({
      onCrash: ({ code, signal }) => {
        // Tell the renderer so the chat UI can clear any frozen "typing"
        // indicator and surface a banner. Without this, an OOM crash
        // mid-stream leaves the UI showing "..." forever because the SSE
        // stream just goes silent.
        const w = getMainWindow();
        if (w) try { w.webContents.send("server-crashed", { code, signal }); } catch {}
      },
    });
  }

  createTray({
    iconPath: ICON_PATH,
    onShow: showWindow,
    onToggle: toggleWindow,
    onQuit: () => {
      setQuitting(true);
      app.quit();
    },
    onNewSession: () => {
      showWindow();
      getMainWindow()?.webContents.executeJavaScript("window.startNewSession?.()");
    },
    getServerStatus: isServerRunning,
    onRestartServer: async () => {
      setRestarting(true);
      await stopServer();
      await new Promise(r => setTimeout(r, 1000));
      const cfg = reloadSAXConfig();
      console.log("[desktop] Tray restart on port", cfg.port);
      startServer();
      setRestarting(false);
      const ready = await waitForServer();
      const w = getMainWindow();
      if (ready && w) {
        const newUrl = `http://127.0.0.1:${cfg.port}/?token=${cfg.authToken}`;
        console.log("[desktop] Reloading window to", newUrl);
        w.loadURL(newUrl);
      }
    },
  });

  registerHotkey(toggleWindow);
  createWindow();

  if (getSetting("autostart")) {
    registerAutostart();
  }

  showNotification("Local Agent X", alreadyRunning ? "Agent is online." : "Starting up…");
});

app.on("activate", () => showWindow());

app.on("before-quit", () => {
  setQuitting(true);
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  stopServer();
  destroyTray();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !getSetting("closeToTray")) {
    setQuitting(true);
    app.quit();
  }
});
