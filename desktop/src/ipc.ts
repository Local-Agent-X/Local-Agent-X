// Renderer → main IPC handlers. The preload script (preload.ts) exposes
// window.desktop.* to the renderer; each method maps to one handler here.
//
// IPC is the canonical bridge between web UI state changes (theme toggle,
// settings checkbox) and OS-level chrome (titleBarOverlay, app
// background, autostart registration).

import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, shell, systemPreferences } from "electron";
import { join, resolve, relative, isAbsolute, sep } from "path";
import { getProjectRoot, reloadLAXConfig, getLAXConfig, LAX_DIR } from "./config";
import { type DesktopSettings, getSetting, setSetting } from "./settings";
import { bgForTheme, applyNativeTheme } from "./theme";
import {
  isServerRunning,
  restartServer,
  setQuitting,
  stopServer,
  getServerPid,
} from "./server-process";
import { showNotification, registerHotkey } from "./hotkey-notifications";
import { getMainWindow, toggleWindow, reapplyMainTitleBarOverlay } from "./window";
import { registerAutostart, unregisterAutostart } from "./autostart";
import {
  isNativeSpeechAvailable,
  startNativeSpeech,
  stopNativeSpeech,
} from "./native-speech";

export function setupIPC(): void {
  ipcMain.handle("get-server-status", async () => {
    return {
      running: await isServerRunning(),
      port: getLAXConfig().port,
      pid: getServerPid(),
    };
  });

  ipcMain.handle("restart-server", async () => {
    const { ready, cfg } = await restartServer();
    const mainWindow = getMainWindow();
    if (ready && mainWindow) {
      const newUrl = `http://127.0.0.1:${cfg.port}/?token=${cfg.authToken}`;
      console.log("[desktop] Reloading window to", newUrl);
      mainWindow.loadURL(newUrl);
    }
    return ready;
  });

  ipcMain.handle("get-settings", () => {
    return {
      autostart: getSetting("autostart"),
      closeToTray: getSetting("closeToTray"),
      globalHotkey: getSetting("globalHotkey"),
    };
  });

  ipcMain.handle("set-setting", (_e, key: string, value: unknown) => {
    // Allowlist the renderer-settable keys + validate the value shape. Without
    // this, a compromised renderer could persist any arbitrary key/value into
    // desktop-settings.json (and type-confuse the handlers below). windowBounds
    // is intentionally excluded — it's set internally by the resize handler.
    const SETTABLE: Record<string, (v: unknown) => boolean> = {
      autostart: (v) => typeof v === "boolean",
      closeToTray: (v) => typeof v === "boolean",
      globalHotkey: (v) => typeof v === "string",
      theme: (v) => v === "dark" || v === "light" || v === "system",
    };
    if (!Object.prototype.hasOwnProperty.call(SETTABLE, key) || !SETTABLE[key](value)) {
      console.warn(`[desktop] set-setting rejected: ${key}`);
      return;
    }
    setSetting(key as keyof DesktopSettings, value as never);
    if (key === "autostart") {
      if (value) registerAutostart();
      else unregisterAutostart();
    }
    if (key === "globalHotkey") {
      globalShortcut.unregisterAll();
      registerHotkey(toggleWindow);
    }
    if (key === "theme") {
      // Live-update the window paint colour so the top strip flips with
      // the rest of the UI instead of staying dark until the next launch.
      const t = value as DesktopSettings["theme"];
      applyNativeTheme(t);
      const mainWindow = getMainWindow();
      mainWindow?.setBackgroundColor(bgForTheme(t));
      if (process.platform !== "darwin") {
        // Re-apply colours AND a zoom-correct overlay height (not the base 32)
        // so changing theme while zoomed doesn't re-introduce the titlebar
        // desync. No-op on macOS / pre-Electron-25 (helper guards internally).
        try { reapplyMainTitleBarOverlay(); } catch { /* not available */ }
      }
    }
  });

  ipcMain.handle("show-notification", (_e, title: string, body: string) => {
    showNotification(title, body);
  });

  // macOS: getUserMedia in a hardened-runtime Electron app does NOT trigger
  // the TCC prompt on its own — the renderer's Chromium media stack expects
  // the host app to have called systemPreferences.askForMediaAccess first.
  // Without this call the mic just silently fails with NotAllowedError and
  // no system dialog ever appears. Renderer invokes this right before
  // getUserMedia. No-op outside darwin (other OSes prompt via getUserMedia
  // directly).
  ipcMain.handle("request-media-access", async (_e, mediaType: "microphone" | "camera") => {
    if (process.platform !== "darwin") return true;
    try {
      return await systemPreferences.askForMediaAccess(mediaType);
    } catch (err) {
      console.warn(`[desktop] askForMediaAccess(${mediaType}) failed:`, err);
      return false;
    }
  });

  // Native OS speech recognition bridge — replaces the broken
  // webkitSpeechRecognition (Browser tier) on macOS + Windows. Renderer
  // invokes start/stop; transcript events stream back on the
  // "native-speech-event" channel (see native-speech.ts).
  ipcMain.handle("native-speech-available", () => isNativeSpeechAvailable());
  ipcMain.handle("native-speech-start", () => { startNativeSpeech(); });
  ipcMain.handle("native-speech-stop", () => { stopNativeSpeech(); });

  ipcMain.handle("toggle-window", () => toggleWindow());
  ipcMain.handle("toggle-devtools", () => {
    const mainWindow = getMainWindow();
    if (mainWindow) mainWindow.webContents.toggleDevTools();
  });

  // Edit actions for the Windows/Linux in-window titlebar. The HTML bar
  // can't carry Electron menu roles, so it routes here and we drive the
  // focused webContents — the same effect roles give the native Mac menu.
  ipcMain.handle("titlebar-edit", (_e, role: "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll") => {
    const wc = getMainWindow()?.webContents;
    if (wc) wc[role]();
  });

  ipcMain.handle("show-about", () => app.showAboutPanel());
  ipcMain.handle("open-file", (_e, relativePath: string) => {
    // Resolve against PROJECT_ROOT, not process.cwd() — the old `..` hack
    // happened to work on Windows when cwd was `<repo>/desktop`, but
    // breaks on a Finder-launched Mac .app (cwd is `/`).
    const root = getProjectRoot();
    if (!root) {
      console.warn(`[desktop] open-file IPC ignored — PROJECT_ROOT unresolved`);
      return Promise.resolve("PROJECT_ROOT unresolved");
    }
    // Contain to PROJECT_ROOT — `relativePath` is renderer-supplied, so a
    // `../../` (or absolute) value would otherwise open ANY file on disk via
    // the OS handler. resolve() collapses traversal; relative() confirms the
    // result stays under root.
    const filePath = resolve(root, relativePath);
    const rel = relative(root, filePath);
    if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
      console.warn(`[desktop] open-file rejected (outside project root): ${relativePath}`);
      return Promise.resolve("rejected: path outside project root");
    }
    console.log(`[desktop] Opening file: ${filePath}`);
    return shell.openPath(filePath);
  });
  ipcMain.handle("quit-app", async () => {
    setQuitting(true);
    await stopServer();
    app.exit(0);
  });

  // Full quit + Electron relaunch. Used after `git pull` so the next boot
  // re-runs reconcile (root build + desktop build + npm installs) against
  // the freshly pulled lockfiles/sources. The server tree is killed and
  // AWAITED before relaunch — app.quit() alone let the old server survive,
  // and the relaunched Electron silently reattached to it, serving
  // hours-old in-memory code while the user believed they'd updated
  // (2026-06-09, all day). app.exit() then guarantees this instance dies
  // regardless of quit-event handlers.
  ipcMain.handle("relaunch-app", async () => {
    setQuitting(true);
    await stopServer();
    app.relaunch();
    app.exit(0);
  });

  // Native folder picker for the Settings → Server workspace location. Returns
  // the chosen absolute path, or null if the user canceled. Cross-platform —
  // Electron's dialog is the OS-native picker on Windows and macOS.
  ipcMain.handle("select-folder", async (_e, opts?: { title?: string; defaultPath?: string }) => {
    const win = getMainWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      title: opts?.title || "Choose folder",
      ...(opts?.defaultPath ? { defaultPath: opts.defaultPath } : {}),
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  // Native OK/Cancel confirmation — used for the "restart required" prompt when
  // a reboot-only server field (port, workspace) is changed. Returns true when
  // the user accepts.
  ipcMain.handle("confirm", async (_e, opts: { message: string; detail?: string; okLabel?: string }) => {
    const win = getMainWindow();
    if (!win) return false;
    const result = await dialog.showMessageBox(win, {
      type: "question",
      buttons: [opts.okLabel || "OK", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      message: opts.message,
      ...(opts.detail ? { detail: opts.detail } : {}),
    });
    return result.response === 0;
  });

  ipcMain.handle("open-in-browser", () => {
    const cfg = getLAXConfig();
    return shell.openExternal(`http://127.0.0.1:${cfg.port}/?token=${cfg.authToken}`);
  });

  // Reveal the uploads folder so the user can browse/prune the raw files.
  // The dir is created by the server at boot, which has run by the time the
  // renderer (where this is triggered) exists.
  ipcMain.handle("open-uploads-folder", () => shell.openPath(join(LAX_DIR, "uploads")));

  ipcMain.handle("copy-app-url", () => {
    const cfg = getLAXConfig();
    clipboard.writeText(`http://127.0.0.1:${cfg.port}/?token=${cfg.authToken}`);
  });

  // App child windows ping us with their sampled body bg + a contrasting
  // symbol color so the native min/max/X overlay can be repainted to
  // match. Eliminates the "LAX-theme top bar over differently-themed app
  // content" seam — strip and overlay share whatever color the app chose
  // for itself. No-op on macOS (no titleBarOverlay) and for the main
  // window (its overlay is theme-driven, not content-driven).
  ipcMain.handle("report-chrome-tint", (event, color: string, symbolColor: string) => {
    if (process.platform === "darwin") return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win === getMainWindow()) return;
    try { win.setTitleBarOverlay({ color, symbolColor, height: 32 }); } catch { /* not available */ }
  });
}
