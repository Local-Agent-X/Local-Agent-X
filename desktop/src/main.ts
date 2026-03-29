/**
 * Open Agent X — Electron Main Process
 *
 * Launches the SAX server as a child process (if not already running),
 * wraps the web UI in a native window, provides system tray, global
 * hotkey, native notifications, and close-to-tray behavior.
 */

import {
  app,
  BrowserWindow,
  globalShortcut,
  Notification,
  ipcMain,
  nativeImage,
  shell,
} from "electron";
import { join, resolve } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { ChildProcess, spawn } from "child_process";
import { homedir } from "os";
import { createTray, destroyTray } from "./tray";
import { registerAutostart, unregisterAutostart, isAutostartEnabled } from "./autostart";

// ── Config ────────────────────────────────────────────────

const SAX_DIR = join(homedir(), ".sax");
const CONFIG_PATH = join(SAX_DIR, "config.json");
const DESKTOP_SETTINGS_PATH = join(SAX_DIR, "desktop-settings.json");
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const ICON_PATH = join(PROJECT_ROOT, "public", "icon.ico");

interface SAXConfig {
  port: number;
  authToken: string;
}

function loadSAXConfig(): SAXConfig {
  const defaults: SAXConfig = { port: 7007, authToken: "" };
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      return {
        port: raw.port ?? defaults.port,
        authToken: raw.authToken ?? defaults.authToken,
      };
    }
  } catch {}
  return defaults;
}

// ── Persistent Settings (simple JSON file) ────────────────

interface DesktopSettings {
  autostart: boolean;
  closeToTray: boolean;
  globalHotkey: string;
  windowBounds: { width: number; height: number };
}

const DEFAULT_SETTINGS: DesktopSettings = {
  autostart: false,
  closeToTray: true,
  globalHotkey: "CommandOrControl+Shift+Space",
  windowBounds: { width: 1200, height: 800 },
};

function loadSettings(): DesktopSettings {
  try {
    if (existsSync(DESKTOP_SETTINGS_PATH)) {
      const raw = JSON.parse(readFileSync(DESKTOP_SETTINGS_PATH, "utf-8"));
      return { ...DEFAULT_SETTINGS, ...raw };
    }
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings: DesktopSettings): void {
  if (!existsSync(SAX_DIR)) mkdirSync(SAX_DIR, { recursive: true });
  writeFileSync(DESKTOP_SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf-8");
}

let settings = loadSettings();

function getSetting<K extends keyof DesktopSettings>(key: K): DesktopSettings[K] {
  return settings[key];
}

function setSetting<K extends keyof DesktopSettings>(key: K, value: DesktopSettings[K]): void {
  settings[key] = value;
  saveSettings(settings);
}

// ── State ─────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
let isQuitting = false;
let saxConfig: SAXConfig;

// ── Server Lifecycle ──────────────────────────────────────

async function isServerRunning(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://127.0.0.1:${saxConfig.port}/api/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

function startServer(): void {
  if (serverProcess) return;

  const distIndex = join(PROJECT_ROOT, "dist", "index.js");
  if (!existsSync(distIndex)) {
    console.error("[desktop] Server not built — run 'npm run build' in project root first");
    return;
  }

  console.log("[desktop] Starting SAX server...");
  serverProcess = spawn("node", ["--max-old-space-size=512", distIndex], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
    windowsHide: true,
  });

  serverProcess.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log("[server]", line);
  });

  serverProcess.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.error("[server]", line);
  });

  serverProcess.on("exit", (code) => {
    console.log(`[desktop] Server exited with code ${code}`);
    serverProcess = null;
    if (!isQuitting) {
      setTimeout(() => {
        if (!isQuitting && !serverProcess) startServer();
      }, 3000);
    }
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!serverProcess) { resolve(); return; }
    console.log("[desktop] Stopping SAX server (pid: " + serverProcess.pid + ")...");
    const proc = serverProcess;
    const pid = proc.pid;
    const forceKill = setTimeout(() => {
      // Windows: SIGTERM doesn't work, use taskkill
      if (pid && process.platform === "win32") {
        try { require("child_process").execSync(`taskkill /PID ${pid} /T /F`, { windowsHide: true, stdio: "ignore" }); } catch {}
      } else {
        try { proc.kill("SIGKILL"); } catch {}
      }
      serverProcess = null;
      resolve();
    }, 2000);
    proc.on("exit", () => {
      clearTimeout(forceKill);
      serverProcess = null;
      resolve();
    });
    // Try graceful first, force kill after 2s
    try { proc.kill("SIGTERM"); } catch {}
  });
}

async function waitForServer(maxWaitMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await isServerRunning()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ── Window Management ─────────────────────────────────────

function createWindow(): void {
  const bounds = getSetting("windowBounds");

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: 600,
    minHeight: 400,
    icon: ICON_PATH,
    title: "Open Agent X",
    backgroundColor: "#0a0a0f",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  const url = `http://127.0.0.1:${saxConfig.port}/?token=${saxConfig.authToken}`;
  mainWindow.loadURL(url);

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("resize", () => {
    if (mainWindow && !mainWindow.isMaximized()) {
      const [width, height] = mainWindow.getSize();
      setSetting("windowBounds", { width, height });
    }
  });

  mainWindow.on("close", (e) => {
    if (!isQuitting && getSetting("closeToTray")) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http") && !url.includes("127.0.0.1")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });
}

function showWindow(): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

function toggleWindow(): void {
  if (mainWindow?.isVisible() && mainWindow?.isFocused()) {
    mainWindow.hide();
  } else {
    showWindow();
  }
}

// ── Global Hotkey ─────────────────────────────────────────

function registerHotkey(): void {
  const hotkey = getSetting("globalHotkey");
  try {
    globalShortcut.register(hotkey, toggleWindow);
    console.log(`[desktop] Global hotkey registered: ${hotkey}`);
  } catch (err) {
    console.error(`[desktop] Failed to register hotkey ${hotkey}:`, err);
  }
}

// ── Native Notifications ──────────────────────────────────

function showNotification(title: string, body: string): void {
  if (Notification.isSupported()) {
    const icon = existsSync(ICON_PATH) ? nativeImage.createFromPath(ICON_PATH) : undefined;
    new Notification({ title, body, icon }).show();
  }
}

// ── IPC Handlers (renderer ↔ main) ───────────────────────

function setupIPC(): void {
  ipcMain.handle("get-server-status", async () => {
    return {
      running: await isServerRunning(),
      port: saxConfig.port,
      pid: serverProcess?.pid ?? null,
    };
  });

  ipcMain.handle("restart-server", async () => {
    await stopServer();
    startServer();
    return waitForServer();
  });

  ipcMain.handle("get-settings", () => {
    return {
      autostart: getSetting("autostart"),
      closeToTray: getSetting("closeToTray"),
      globalHotkey: getSetting("globalHotkey"),
    };
  });

  ipcMain.handle("set-setting", (_e, key: string, value: unknown) => {
    setSetting(key as keyof DesktopSettings, value as any);
    if (key === "autostart") {
      if (value) registerAutostart();
      else unregisterAutostart();
    }
    if (key === "globalHotkey") {
      globalShortcut.unregisterAll();
      registerHotkey();
    }
  });

  ipcMain.handle("show-notification", (_e, title: string, body: string) => {
    showNotification(title, body);
  });

  ipcMain.handle("toggle-window", () => toggleWindow());
  ipcMain.handle("quit-app", () => {
    isQuitting = true;
    app.quit();
  });
}

// ── App Lifecycle ─────────────────────────────────────────

app.on("ready", async () => {
  saxConfig = loadSAXConfig();

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  app.on("second-instance", () => showWindow());

  setupIPC();

  const alreadyRunning = await isServerRunning();
  if (!alreadyRunning) {
    startServer();
  }

  const serverReady = alreadyRunning || (await waitForServer());
  if (!serverReady) {
    showNotification(
      "Open Agent X",
      "Server failed to start. Check that the project is built (npm run build)."
    );
  }

  createTray({
    iconPath: ICON_PATH,
    onShow: showWindow,
    onToggle: toggleWindow,
    onQuit: () => {
      isQuitting = true;
      app.quit();
    },
    onNewSession: () => {
      showWindow();
      mainWindow?.webContents.executeJavaScript("window.startNewSession?.()");
    },
    getServerStatus: isServerRunning,
    onRestartServer: async () => {
      await stopServer();
      startServer();
    },
  });

  registerHotkey();
  createWindow();

  if (getSetting("autostart")) {
    registerAutostart();
  }

  showNotification("Open Agent X", serverReady ? "Agent is online." : "Starting up...");
});

app.on("activate", () => showWindow());

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  stopServer();
  destroyTray();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !getSetting("closeToTray")) {
    isQuitting = true;
    app.quit();
  }
});

export { showWindow, toggleWindow, showNotification, isQuitting, saxConfig };
