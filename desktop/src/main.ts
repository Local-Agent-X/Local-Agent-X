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

// ── Chromium flags (must be set before app.ready) ─────────
app.commandLine.appendSwitch("unsafely-treat-insecure-origin-as-secure", "http://127.0.0.1:7007,http://127.0.0.1:6868,http://127.0.0.1:6969,http://127.0.0.1");
app.commandLine.appendSwitch("enable-features", "WebRTCPipeWireCapturer");
app.commandLine.appendSwitch("enable-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream"); // Auto-grant mic without prompt

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
let isRestarting = false;
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
    if (!isQuitting && !isRestarting) {
      setTimeout(() => {
        if (!isQuitting && !isRestarting && !serverProcess) startServer();
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
    title: "",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0a0a0f",
      symbolColor: "#40f0f0",
      height: 32,
    },
    backgroundColor: "#0a0a0f",
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
  mainWindow.loadURL(url);

  // Inject custom title bar menu into the page
  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow?.webContents.executeJavaScript(`
      (function() {
        if (document.getElementById('desktop-titlebar')) return;
        const bar = document.createElement('div');
        bar.id = 'desktop-titlebar';
        bar.style.cssText = 'position:fixed;top:0;left:0;right:138px;height:32px;z-index:99999;display:flex;align-items:center;background:#0a0a0f;-webkit-app-region:drag;font-family:"Segoe UI",sans-serif;font-size:12px;user-select:none;';

        const menus = [
          { label:'File', items:['New Session','Restart Server','—','Quit'] },
          { label:'Edit', items:['Undo','Redo','—','Cut','Copy','Paste'] },
          { label:'View', items:['Reload','Toggle Agents','Toggle DevTools','—','Zoom In','Zoom Out','Reset Zoom'] },
          { label:'Window', items:['Minimize','Close to Tray'] },
          { label:'Help', items:['About'] }
        ];

        let openMenu = null;
        function closeAllMenus() {
          document.querySelectorAll('.dtb-dd').forEach(d => d.style.display='none');
          document.querySelectorAll('.dtb-btn').forEach(b => { b.style.color='#888'; b.style.background=''; });
          openMenu = null;
        }
        document.addEventListener('click', (e) => {
          if (!e.target.closest('#desktop-titlebar')) closeAllMenus();
        });

        const favicon = document.createElement('img');
        favicon.src = '/favicon.png';
        favicon.style.cssText = 'width:16px;height:16px;margin:0 8px 0 8px;-webkit-app-region:no-drag;';
        bar.appendChild(favicon);

        menus.forEach(menu => {
          const btn = document.createElement('div');
          btn.className = 'dtb-btn';
          btn.textContent = menu.label;
          btn.style.cssText = 'padding:4px 8px;color:#888;cursor:pointer;-webkit-app-region:no-drag;position:relative;';

          const dd = document.createElement('div');
          dd.className = 'dtb-dd';
          dd.style.cssText = 'display:none;position:absolute;top:100%;left:0;background:#0a0a0f;border:1px solid #1a1a2f;min-width:180px;box-shadow:0 4px 12px rgba(0,0,0,0.5);z-index:100000;padding:4px 0;';

          menu.items.forEach(item => {
            if (item === '—') {
              const sep = document.createElement('div');
              sep.style.cssText = 'height:1px;background:#1a1a2f;margin:4px 0;';
              dd.appendChild(sep);
            } else {
              const it = document.createElement('div');
              it.textContent = item;
              it.style.cssText = 'padding:6px 12px;color:#ccc;cursor:pointer;';
              it.onmouseenter = () => it.style.background='#1a1a2f';
              it.onmouseleave = () => it.style.background='';
              it.onclick = (e) => {
                e.stopPropagation();
                closeAllMenus();
                if(window.desktop) {
                  if(item==='Quit') window.desktop.quit();
                  if(item==='Restart Server') window.desktop.restartServer();
                  if(item==='New Session') window.startNewSession?.();
                  if(item==='Toggle DevTools') window.desktop.toggleDevTools();
                }
                if(item==='Reload') location.reload();
                if(item==='Toggle Agents') { const b=document.getElementById('agents-toggle'); if(b) b.click(); }
                if(item==='Zoom In') document.body.style.zoom=(parseFloat(document.body.style.zoom||'1')+0.1)+'';
                if(item==='Zoom Out') document.body.style.zoom=(parseFloat(document.body.style.zoom||'1')-0.1)+'';
                if(item==='Reset Zoom') document.body.style.zoom='1';
                if(item==='Minimize') window.desktop?.toggleWindow();
                if(item==='Close to Tray') window.desktop?.toggleWindow();
              };
              dd.appendChild(it);
            }
          });

          btn.appendChild(dd);

          // Click to toggle, hover to switch between open menus
          btn.onclick = (e) => {
            e.stopPropagation();
            if (openMenu === dd) { closeAllMenus(); return; }
            closeAllMenus();
            dd.style.display='block';
            btn.style.color='#40f0f0';
            btn.style.background='#1a1a2f';
            openMenu = dd;
          };
          btn.onmouseenter = () => {
            if (openMenu && openMenu !== dd) {
              closeAllMenus();
              dd.style.display='block';
              btn.style.color='#40f0f0';
              btn.style.background='#1a1a2f';
              openMenu = dd;
            }
          };

          bar.appendChild(btn);
        });

        document.body.prepend(bar);
        document.body.classList.add('desktop-frame');
      })();
    `);
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // Disable Ctrl+R / Ctrl+Shift+R / F5 hard refresh (causes port/localStorage issues)
  mainWindow.webContents.on("before-input-event", (_e, input) => {
    if (input.key === "F5" || (input.control && input.key.toLowerCase() === "r")) {
      _e.preventDefault();
    }
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
    // External links → system browser
    if (url.startsWith("http") && !url.includes("127.0.0.1")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    // Local app links (e.g. /apps/xyz) → open in frameless Electron window with auth
    if (url.includes("127.0.0.1")) {
      const appWin = new BrowserWindow({
        width: 1000,
        height: 700,
        icon: ICON_PATH,
        backgroundColor: "#0a0a0f",
        frame: false,
        titleBarStyle: "hidden",
        titleBarOverlay: {
          color: "#0a0a0f",
          symbolColor: "#40f0f0",
          height: 32,
        },
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      const separator = url.includes("?") ? "&" : "?";
      appWin.loadURL(`${url}${separator}token=${saxConfig.authToken}`);
      return { action: "deny" };
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
    isRestarting = true;
    await stopServer();
    await new Promise(r => setTimeout(r, 1000));
    saxConfig = loadSAXConfig();
    console.log("[desktop] Restarting on port", saxConfig.port);
    startServer();
    isRestarting = false;
    const ready = await waitForServer();
    if (ready && mainWindow) {
      const newUrl = `http://127.0.0.1:${saxConfig.port}/?token=${saxConfig.authToken}`;
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
  ipcMain.handle("toggle-devtools", () => {
    if (mainWindow) mainWindow.webContents.toggleDevTools();
  });
  ipcMain.handle("quit-app", () => {
    isQuitting = true;
    app.quit();
  });
}

// ── App Lifecycle ─────────────────────────────────────────

app.on("ready", async () => {
  saxConfig = loadSAXConfig();

  // Grant mic/camera permissions globally before any window is created
  const { session } = require("electron");
  session.defaultSession.setPermissionRequestHandler((_wc: any, permission: string, callback: (granted: boolean) => void) => {
    callback(true); // Allow all permissions (single-user local app)
  });
  session.defaultSession.setPermissionCheckHandler(() => true);

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
      isRestarting = true;
      await stopServer();
      await new Promise(r => setTimeout(r, 1000));
      saxConfig = loadSAXConfig();
      console.log("[desktop] Tray restart on port", saxConfig.port);
      startServer();
      isRestarting = false;
      const ready = await waitForServer();
      if (ready && mainWindow) {
        const newUrl = `http://127.0.0.1:${saxConfig.port}/?token=${saxConfig.authToken}`;
        console.log("[desktop] Reloading window to", newUrl);
        mainWindow.loadURL(newUrl);
      }
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
