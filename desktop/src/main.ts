/**
 * Local Agent X — Electron Main Process
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
  nativeTheme,
  shell,
} from "electron";
import { join, resolve } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { ChildProcess, spawn } from "child_process";
import { homedir } from "os";
import { createTray, destroyTray } from "./tray";
import { registerAutostart, unregisterAutostart, isAutostartEnabled } from "./autostart";

// ── Chromium flags (must be set before app.ready) ─────────
// Only mark our own server origin as secure — not every loopback port.
// The port is read from config at runtime, but Chromium flags must be set
// before app.ready, so we read the config file early here.
const _earlyPort = (() => { try { const p = require("path"); const f = require("fs"); const c = p.join(require("os").homedir(), ".lax", "config.json"); if (f.existsSync(c)) { return JSON.parse(f.readFileSync(c, "utf-8")).port || 7007; } } catch {} return 7007; })();
app.commandLine.appendSwitch("unsafely-treat-insecure-origin-as-secure", `http://127.0.0.1:${_earlyPort}`);
app.commandLine.appendSwitch("enable-features", "WebRTCPipeWireCapturer");
app.commandLine.appendSwitch("enable-media-stream");
// Removed use-fake-ui-for-media-stream — the permission request handler
// in app.ready now controls media grants explicitly.

// ── Config ────────────────────────────────────────────────

const SAX_DIR = join(homedir(), ".lax");
const CONFIG_PATH = join(SAX_DIR, "config.json");
const DESKTOP_SETTINGS_PATH = join(SAX_DIR, "desktop-settings.json");
// In packaged mode __dirname is inside app.asar — use config to find the live repo
const PROJECT_ROOT = (() => {
  const devRoot = resolve(__dirname, "..", "..");
  if (!app.isPackaged) return devRoot;
  // Packaged: read projectRoot from ~/.lax/config.json so we always run latest code
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".lax", "config.json"), "utf-8"));
    if (cfg.projectRoot && existsSync(join(cfg.projectRoot, "dist", "index.js"))) {
      return resolve(cfg.projectRoot);
    }
  } catch {}
  return devRoot;
})();
// PNG works for both BrowserWindow + Tray on Windows/Mac/Linux at runtime.
// The platform-specific .ico/.icns are used by electron-builder for the
// packaged installer art, not at runtime.
const ICON_PATH = join(PROJECT_ROOT, "public", "icon.png");

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
  // Mirrors the renderer's sax_theme so the BrowserWindow paint colour matches
  // the web UI's theme. Renderer toggles push the new value here via IPC.
  theme: "dark" | "light" | "system";
}

const DEFAULT_SETTINGS: DesktopSettings = {
  autostart: false,
  closeToTray: true,
  globalHotkey: "CommandOrControl+Shift+Space",
  windowBounds: { width: 1200, height: 800 },
  theme: "dark",
};

// Paint colour for the BrowserWindow underneath the HTML. Visible behind
// the macOS traffic-light strip when the title bar is hidden, and as the
// initial fill before HTML loads. Must follow the renderer theme so a
// light-mode UI doesn't show a dark border at the top of the window.
function bgForTheme(theme: DesktopSettings["theme"]): string {
  if (theme === "light") return "#ffffff";
  if (theme === "system") return nativeTheme.shouldUseDarkColors ? "#0a0a0f" : "#ffffff";
  return "#0a0a0f";
}

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

  // Prefer the compiled build (faster startup, lower memory). Fall back to
  // tsx so the .app still works when `npm run build` is broken or skipped —
  // matches what `npm run dev` does and survives mid-refactor states where
  // dist/ won't compile.
  const distIndex = join(PROJECT_ROOT, "dist", "index.js");
  const srcIndex = join(PROJECT_ROOT, "src", "index.ts");
  const useCompiled = existsSync(distIndex);
  const nodeArgs = useCompiled
    ? ["--max-old-space-size=512", distIndex]
    : ["--max-old-space-size=512", "--import=tsx", srcIndex];

  if (!useCompiled && !existsSync(srcIndex)) {
    console.error("[desktop] Neither dist/index.js nor src/index.ts found in PROJECT_ROOT — refusing to start");
    return;
  }

  // GUI-launched Mac apps (Finder/Launchpad/Spotlight) inherit a minimal PATH
  // that excludes Homebrew, nvm, and asdf. Augment so `node` resolves whether
  // the user installed it via brew (arm64 or intel), nvm, or system pkg.
  const PATH_AUGMENTS = [
    "/opt/homebrew/bin", "/opt/homebrew/sbin",  // Apple Silicon Homebrew
    "/usr/local/bin", "/usr/local/sbin",         // Intel Homebrew / system-wide installs
    join(homedir(), ".nvm/versions/node/current/bin"),  // nvm "current" symlink (if set)
  ];
  const existingPath = (process.env.PATH || "").split(":");
  const augmentedPath = [...PATH_AUGMENTS, ...existingPath].filter((p, i, a) => p && a.indexOf(p) === i).join(":");

  console.log(`[desktop] Starting SAX server (${useCompiled ? "compiled" : "tsx"} mode)...`);
  serverProcess = spawn("node", nodeArgs, {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: augmentedPath },
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
  mainWindow.loadURL(url);

  // Inject custom title bar menu into the page.
  // SKIP on macOS — Mac uses the native menu bar at the top of the screen
  // (Local Agent X | File | Edit | View | Window | Help) and the native
  // window chrome already supplies traffic lights. The custom HTML titlebar
  // was designed for Windows/Linux where the in-window menu is the norm;
  // on Mac it duplicates chrome and clashes with system conventions.
  mainWindow.webContents.on("did-finish-load", () => {
    if (process.platform === "darwin") return;
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

  // Intercept navigation to document files — open with system default app instead
  mainWindow.webContents.on("will-navigate", (e, url) => {
    console.log(`[desktop] will-navigate: ${url}`);
    const DOC_EXTENSIONS = /\.(docx?|xlsx?|pptx?|pdf|csv)$/i;
    try {
      const pathname = new URL(url).pathname;
      if (DOC_EXTENSIONS.test(pathname)) {
        e.preventDefault();
        const relativePath = pathname.startsWith("/files/")
          ? join("workspace", decodeURIComponent(pathname.slice(7)))
          : decodeURIComponent(pathname.slice(1));
        // Resolve against PROJECT_ROOT (the live repo), not process.cwd() —
        // a Finder/Launchpad-launched .app has cwd `/`; a Windows
        // desktop-launch.bat has cwd `<repo>/desktop`. Neither resolves the
        // workspace/ path correctly. PROJECT_ROOT is the single source of
        // truth (computed once at boot from ~/.lax/config.json or dev path).
        const filePath = join(PROJECT_ROOT, relativePath);
        shell.openPath(filePath).then((err) => {
          if (err) console.warn(`[desktop] Failed to open ${filePath}: ${err}`);
        });
      }
    } catch { /* not a valid URL — let it navigate normally */ }
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
    console.log(`[desktop] windowOpenHandler: ${url}`);
    // External links → system browser
    if (url.startsWith("http") && !url.includes("127.0.0.1")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    // Local file links → detect document/file extensions and open with system default app
    const appOrigin = `http://127.0.0.1:${saxConfig.port}`;
    if (url.startsWith(appOrigin)) {
      const pathname = new URL(url).pathname;

      // Document file extensions → open with system default app (Word, Excel, etc.)
      const DOC_EXTENSIONS = /\.(docx?|xlsx?|pptx?|pdf|csv)$/i;
      if (DOC_EXTENSIONS.test(pathname)) {
        // /files/foo.docx → workspace/foo.docx on disk, resolved against
        // PROJECT_ROOT (see note in the will-navigate handler above).
        const relativePath = pathname.startsWith("/files/")
          ? join("workspace", decodeURIComponent(pathname.slice(7)))
          : decodeURIComponent(pathname.slice(1));
        const filePath = join(PROJECT_ROOT, relativePath);
        shell.openPath(filePath).then((err) => {
          if (err) console.warn(`[desktop] Failed to open ${filePath}: ${err}`);
        });
        return { action: "deny" };
      }

      // /files/ links → let Electron's built-in download handler process them
      // The will-download session handler above will auto-open doc files
      if (pathname.startsWith("/files/")) {
        return { action: "allow" };
      }
    }

    // Local app links (e.g. /apps/xyz) → open in frameless Electron window with auth
    // Only attach token to our own server origin, not arbitrary loopback services
    if (url.startsWith(appOrigin)) {
      const appWin = new BrowserWindow({
        width: 1000,
        height: 700,
        icon: ICON_PATH,
        backgroundColor: bgForTheme(getSetting("theme")),
        frame: false,
        titleBarStyle: "hidden",
        titleBarOverlay: {
          color: "#0a0a0f",
          symbolColor: "#40f0f0",
          height: 32,
        },
        webPreferences: {
          preload: join(__dirname, "preload.js"),
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
    if (key === "theme") {
      // Live-update the window paint colour so the top strip flips with the
      // rest of the UI instead of staying dark until the next launch.
      mainWindow?.setBackgroundColor(bgForTheme(value as DesktopSettings["theme"]));
    }
  });

  ipcMain.handle("show-notification", (_e, title: string, body: string) => {
    showNotification(title, body);
  });

  ipcMain.handle("toggle-window", () => toggleWindow());
  ipcMain.handle("toggle-devtools", () => {
    if (mainWindow) mainWindow.webContents.toggleDevTools();
  });
  ipcMain.handle("open-file", (_e: any, relativePath: string) => {
    // Resolve against PROJECT_ROOT, not process.cwd() — the old `..` hack
    // happened to work on Windows when cwd was `<repo>/desktop`, but breaks
    // on a Finder-launched Mac .app (cwd is `/`).
    const filePath = join(PROJECT_ROOT, relativePath);
    console.log(`[desktop] Opening file: ${filePath}`);
    return shell.openPath(filePath);
  });
  ipcMain.handle("quit-app", () => {
    isQuitting = true;
    app.quit();
  });
}

// ── App Lifecycle ─────────────────────────────────────────

app.on("ready", async () => {
  saxConfig = loadSAXConfig();

  // Grant only the permissions the app actually needs — not a blanket allow
  const { session } = require("electron");
  const ALLOWED_PERMISSIONS = new Set([
    "media",            // mic/camera for voice features
    "mediaKeySystem",   // DRM key system (media playback)
    "notifications",    // desktop notifications
    "clipboard-read",   // paste support
    "clipboard-sanitized-write",
  ]);
  const APP_ORIGIN = `http://127.0.0.1:${saxConfig.port}`;
  // Auto-open downloaded document files instead of just saving them
  session.defaultSession.on("will-download", (_event: any, item: any) => {
    const filename = item.getFilename();
    const DOC_EXTENSIONS = /\.(docx?|xlsx?|pptx?|pdf|csv)$/i;
    if (DOC_EXTENSIONS.test(filename)) {
      // Save to temp, then open with system default app
      const savePath = join(require("os").tmpdir(), filename);
      item.setSavePath(savePath);
      item.once("done", (_e: any, state: string) => {
        if (state === "completed") {
          console.log(`[desktop] Opening downloaded file: ${savePath}`);
          shell.openPath(savePath);
        }
      });
    }
  });

  session.defaultSession.setPermissionRequestHandler((webContents: any, permission: string, callback: (granted: boolean) => void) => {
    const requestOrigin = webContents?.getURL?.() || "";
    if (requestOrigin.startsWith(APP_ORIGIN) && ALLOWED_PERMISSIONS.has(permission)) {
      callback(true);
    } else {
      console.warn(`[desktop] Denied permission "${permission}" for ${requestOrigin}`);
      callback(false);
    }
  });
  session.defaultSession.setPermissionCheckHandler((_wc: any, permission: string, requestingOrigin: string) => {
    return requestingOrigin.startsWith(APP_ORIGIN) && ALLOWED_PERMISSIONS.has(permission);
  });

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
      "Local Agent X",
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

  showNotification("Local Agent X", serverReady ? "Agent is online." : "Starting up...");
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
