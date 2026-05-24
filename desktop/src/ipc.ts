// Renderer → main IPC handlers. The preload script (preload.ts) exposes
// window.desktop.* to the renderer; each method maps to one handler here.
//
// IPC is the canonical bridge between web UI state changes (theme toggle,
// settings checkbox) and OS-level chrome (titleBarOverlay, app
// background, autostart registration).

import { app, BrowserWindow, globalShortcut, ipcMain, shell } from "electron";
import { join } from "path";
import { getProjectRoot, reloadSAXConfig, getSAXConfig } from "./config";
import { type DesktopSettings, getSetting, setSetting } from "./settings";
import { bgForTheme, overlayForTheme, applyNativeTheme } from "./theme";
import {
  isServerRunning,
  stopServer,
  startServer,
  waitForServer,
  setQuitting,
  setRestarting,
  getServerPid,
} from "./server-process";
import { showNotification, registerHotkey } from "./hotkey-notifications";
import { getMainWindow, toggleWindow } from "./window";
import { registerAutostart, unregisterAutostart } from "./autostart";

export function setupIPC(): void {
  ipcMain.handle("get-server-status", async () => {
    return {
      running: await isServerRunning(),
      port: getSAXConfig().port,
      pid: getServerPid(),
    };
  });

  ipcMain.handle("restart-server", async () => {
    setRestarting(true);
    await stopServer();
    await new Promise(r => setTimeout(r, 1000));
    const cfg = reloadSAXConfig();
    console.log("[desktop] Restarting on port", cfg.port);
    startServer();
    setRestarting(false);
    const ready = await waitForServer();
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
        try { mainWindow?.setTitleBarOverlay(overlayForTheme(t)); } catch { /* not available pre-Electron 25 */ }
      }
    }
  });

  ipcMain.handle("show-notification", (_e, title: string, body: string) => {
    showNotification(title, body);
  });

  ipcMain.handle("toggle-window", () => toggleWindow());
  ipcMain.handle("toggle-devtools", () => {
    const mainWindow = getMainWindow();
    if (mainWindow) mainWindow.webContents.toggleDevTools();
  });
  ipcMain.handle("open-file", (_e, relativePath: string) => {
    // Resolve against PROJECT_ROOT, not process.cwd() — the old `..` hack
    // happened to work on Windows when cwd was `<repo>/desktop`, but
    // breaks on a Finder-launched Mac .app (cwd is `/`).
    const root = getProjectRoot();
    if (!root) {
      console.warn(`[desktop] open-file IPC ignored — PROJECT_ROOT unresolved`);
      return Promise.resolve("PROJECT_ROOT unresolved");
    }
    const filePath = join(root, relativePath);
    console.log(`[desktop] Opening file: ${filePath}`);
    return shell.openPath(filePath);
  });
  ipcMain.handle("quit-app", () => {
    setQuitting(true);
    app.quit();
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
