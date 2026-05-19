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
  Menu,
  MenuItem,
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
  // Packaged: read projectRoot from ~/.lax/config.json so we always run latest code.
  // Sentinel is src/index.ts (not dist/index.js) — we run the server from src
  // via tsx now, so dist may not exist on a fresh install or after a clean.
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".lax", "config.json"), "utf-8"));
    if (cfg.projectRoot && existsSync(join(cfg.projectRoot, "src", "index.ts"))) {
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

// Windows titleBarOverlay control colors. Native widget, can't use CSS vars,
// so we resolve to concrete hex per theme and call setTitleBarOverlay()
// whenever the renderer's theme changes. Without this the min/max/X strip
// stays dark even in light mode — visible black band across the top.
function overlayForTheme(theme: DesktopSettings["theme"]): { color: string; symbolColor: string; height: number } {
  const isDark = theme === "dark" || (theme === "system" && nativeTheme.shouldUseDarkColors);
  return isDark
    ? { color: "#0a0a0f", symbolColor: "#40f0f0", height: 32 }
    : { color: "#ffffff", symbolColor: "#1a1a2e", height: 32 };
}

// Tells Windows itself which theme our app prefers. Without this set,
// Windows paints the title bar overlay using the OS-level light/dark
// setting on first frame — before Electron applies our titleBarOverlay
// config. Symptom: LAX is in dark mode but the X/min/max strip paints
// white briefly until a theme toggle "wakes up" the overlay. Setting
// nativeTheme.themeSource forces Windows into our chosen palette at
// the OS chrome level, so the first paint is already correct.
function applyNativeTheme(theme: DesktopSettings["theme"]): void {
  nativeTheme.themeSource = theme === "light" ? "light" : theme === "dark" ? "dark" : "system";
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

  // Always run the server from src/index.ts via tsx. We deliberately do NOT
  // prefer a compiled dist/ even when present — that path created a recurring
  // "I changed source but the running code is stale" class of bug: users (and
  // the Restart Server menu) respawn the server expecting their src/ edits
  // to take effect, but the spawn pointed at an older dist/index.js until
  // someone remembered to `npm run build`. tsx adds ~2s to cold start
  // (negligible against the full Electron + Ollama + memory-warm boot) in
  // exchange for "what's on disk in src/ IS what runs" — structurally
  // impossible for the two to drift. `npm run build` still exists for
  // packaging a binary distribution without source; the runtime path
  // doesn't depend on it.
  const srcIndex = join(PROJECT_ROOT, "src", "index.ts");
  if (!existsSync(srcIndex)) {
    console.error(`[desktop] src/index.ts not found at ${srcIndex} — refusing to start`);
    return;
  }
  const nodeArgs = ["--max-old-space-size=4096", "--import=tsx", srcIndex];

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

  console.log(`[desktop] Starting LAX server (tsx, ${srcIndex})...`);
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

  serverProcess.on("exit", (code, signal) => {
    // Crash classification — exit codes / signals worth surfacing:
    //   code === 0          : clean shutdown (rare except via tray Quit)
    //   code !== 0          : server threw, hit OOM, or process.exit(1)
    //   signal === "SIGKILL": OS killed it (often OOM via macOS jetsam)
    const wasUnclean = code !== 0 || signal != null;
    console.log(`[desktop] Server exited code=${code} signal=${signal}`);
    serverProcess = null;
    if (wasUnclean && mainWindow && !isQuitting && !isRestarting) {
      // Tell the renderer so the chat UI can clear any frozen "typing"
      // indicator and surface a banner. Without this, an OOM crash mid-
      // stream leaves the UI showing "..." forever because the SSE
      // stream just goes silent — no error event the UI knows to catch.
      try {
        mainWindow.webContents.send("server-crashed", { code, signal });
      } catch { /* renderer may already be gone */ }
    }
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
    // macOS: "hiddenInset" hides the visual title bar but keeps a native
    // drag region (the top ~28px) so the window stays draggable and the
    // traffic-light buttons sit inside our content area. With plain
    // "hidden" the user has no way to move the window short of toggling
    // fullscreen. Windows/Linux keep the JS-injected branded titlebar
    // (see did-finish-load handler below) and use titleBarOverlay for
    // the min/max/X buttons.
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
        bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:32px;z-index:99999;display:flex;align-items:center;background:var(--bg, #0a0a0f);-webkit-app-region:drag;font-family:"Segoe UI",sans-serif;font-size:12px;user-select:none;';

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
          document.querySelectorAll('.dtb-btn').forEach(b => { b.style.color='var(--muted, #888)'; b.style.background=''; });
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
          btn.style.cssText = 'padding:4px 8px;color:var(--muted, #888);cursor:pointer;-webkit-app-region:no-drag;position:relative;';

          const dd = document.createElement('div');
          dd.className = 'dtb-dd';
          dd.style.cssText = 'display:none;position:absolute;top:100%;left:0;background:var(--bg, #0a0a0f);border:1px solid var(--border, #1a1a2f);min-width:180px;box-shadow:0 4px 12px rgba(0,0,0,0.5);z-index:100000;padding:4px 0;';

          menu.items.forEach(item => {
            if (item === '—') {
              const sep = document.createElement('div');
              sep.style.cssText = 'height:1px;background:var(--border, #1a1a2f);margin:4px 0;';
              dd.appendChild(sep);
            } else {
              const it = document.createElement('div');
              it.textContent = item;
              it.style.cssText = 'padding:6px 12px;color:var(--text, #ccc);cursor:pointer;';
              it.onmouseenter = () => it.style.background='var(--hover, #1a1a2f)';
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
            btn.style.color='var(--accent, #40f0f0)';
            btn.style.background='var(--hover, #1a1a2f)';
            openMenu = dd;
          };
          btn.onmouseenter = () => {
            if (openMenu && openMenu !== dd) {
              closeAllMenus();
              dd.style.display='block';
              btn.style.color='var(--accent, #40f0f0)';
              btn.style.background='var(--hover, #1a1a2f)';
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

  // Right-click context menu. Electron's `spellcheck: true` gives the red
  // underline for free, but the menu (suggestions, Add to Dictionary,
  // cut/copy/paste/select-all) has to be built manually — without this,
  // right-click on a misspelled word does nothing. Mac users especially
  // expect a native-feeling context menu here.
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
        // Mac: "hiddenInset" puts the traffic lights inside our content
        // with a native drag region. Windows: keep titleBarOverlay for
        // min/max/X buttons in the top-right; we inject a draggable
        // strip below so users can move the window and the OS buttons
        // don't sit on top of the app's own UI (which was the live
        // failure for the TV Remote app: the app's "Input" button was
        // covered by the close button).
        titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
        titleBarOverlay: process.platform === "darwin" ? undefined : overlayForTheme(getSetting("theme")),
        webPreferences: {
          preload: join(__dirname, "preload.js"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      const separator = url.includes("?") ? "&" : "?";
      appWin.loadURL(`${url}${separator}token=${saxConfig.authToken}`);
      // Inject a draggable strip on every page load. Reserve a slot on
      // the platform-appropriate side so the OS controls stay clickable:
      // Windows/Linux → 138px on the right (matches titleBarOverlay width
      // for min/max/X). Mac → 80px on the left (traffic-light bounds).
      // Runs on every navigation so SPA-internal route changes inside
      // an app keep the drag region.
      //
      // App pages are arbitrary user-built HTML — they don't share LAX's
      // :root CSS variables. So the strip's background can't use var(--bg);
      // we bake the theme-appropriate translucent fill in at injection
      // time. New windows opened later pick up the current theme; an
      // already-open app window keeps its strip color from when it
      // opened (acceptable — apps tend to be short-lived popups).
      appWin.webContents.on("did-finish-load", () => {
        const reserveLeft = process.platform === "darwin" ? 80 : 0;
        const reserveRight = process.platform === "darwin" ? 0 : 138;
        const theme = getSetting("theme");
        const isDark = theme === "dark" || (theme === "system" && nativeTheme.shouldUseDarkColors);
        // Fallback used only when the app page has no detectable bg color
        // (transparent body + transparent html). Matches LAX theme.
        const fallbackBg = isDark ? "#0a0a0f" : "#ffffff";
        const js = `
          (() => {
            if (document.getElementById('__lax_drag_strip')) return;

            // Sample the app's effective background so the top bar
            // matches the page instead of LAX's theme. body bg first;
            // fall back to html bg; fall back to LAX theme. App pages
            // are arbitrary user-built HTML — they can be dark, light,
            // or anything the agent painted them, independent of LAX's
            // own theme. Reading the computed background here, painting
            // the strip with it, and reporting it back to main for the
            // OS overlay = both halves of the top 32px get the SAME
            // exact color, no visible seam.
            function readBg(el) {
              const c = getComputedStyle(el).backgroundColor;
              return (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') ? c : null;
            }
            const tint = readBg(document.body) || readBg(document.documentElement) || '${fallbackBg}';
            // Parse rgb/rgba to compute luminance — pick a symbol color
            // (the OS button icons) that contrasts against the tint.
            const m = String(tint).match(/rgba?\\((\\d+)[,\\s]+(\\d+)[,\\s]+(\\d+)/);
            let isDarkTint = false;
            let hexTint = tint;
            if (m) {
              const r = +m[1], g = +m[2], b = +m[3];
              isDarkTint = (0.299*r + 0.587*g + 0.114*b) / 255 < 0.5;
              const toHex = (v) => ('0' + (+v).toString(16)).slice(-2);
              hexTint = '#' + toHex(r) + toHex(g) + toHex(b);
            } else {
              isDarkTint = ${isDark ? "true" : "false"};
            }
            const symbolColor = isDarkTint ? '#e0e0e8' : '#1a1a2e';

            const bar = document.createElement('div');
            bar.id = '__lax_drag_strip';
            bar.style.cssText = 'position:fixed;top:0;left:${reserveLeft}px;right:${reserveRight}px;height:32px;z-index:2147483647;background:' + tint + ';-webkit-app-region:drag;pointer-events:auto;';
            document.body.appendChild(bar);

            // Tell main to repaint the native OS button strip with the
            // same color we used for our drag region. After this fires
            // there's no visible boundary between strip and overlay.
            if (window.desktop && window.desktop.reportChromeTint) {
              try { window.desktop.reportChromeTint(hexTint, symbolColor); } catch (e) {}
            }
            // Push page content down so the app's own UI doesn't sit
            // under the drag strip. Add to existing padding rather than
            // overwriting in case the app set its own.
            const cs = getComputedStyle(document.body);
            const cur = parseInt(cs.paddingTop) || 0;
            if (cur < 32) document.body.style.paddingTop = (cur + 32) + 'px';
          })();
        `;
        appWin.webContents.executeJavaScript(js).catch(() => { /* page unloaded */ });
      });
      return { action: "deny" };
    }
    return { action: "deny" };
  });
}

// Native macOS application menu. The custom JS-injected titlebar is skipped
// on darwin (Mac uses the native top-of-screen menu bar), so every
// app-specific action that used to live in that titlebar — New Session,
// Restart Server, Show/Hide Agents, Toggle DevTools, etc. — has to be
// surfaced here or it's lost. Renderer-targeted items dispatch via
// webContents.executeJavaScript, same as the old in-window menu's handlers.
function setupApplicationMenu(): void {
  if (process.platform !== "darwin") return; // Windows/Linux keep the in-window titlebar
  const triggerRenderer = (js: string) => {
    mainWindow?.webContents.executeJavaScript(js).catch(() => { /* renderer not ready */ });
  };
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "New Session",
          accelerator: "CmdOrCtrl+N",
          click: () => triggerRenderer("window.startNewSession?.()"),
        },
        { type: "separator" },
        {
          label: "Restart Server",
          accelerator: "CmdOrCtrl+Shift+R",
          click: async () => { await stopServer(); startServer(); },
        },
        { type: "separator" },
        // close-to-tray is wired up on mainWindow's close handler, so this
        // hides the window instead of quitting the app
        { role: "close", label: "Close to Tray" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        // Reload the renderer. Without this, a stale frontend (UI state
        // baked in pre-OAuth, cached model list, or any code update in
        // dev) had no first-class way to refresh — Cmd-R is bound by
        // Electron only when DevTools is focused, which non-technical
        // users won't discover. Surfaced here with the standard mac
        // shortcut.
        { role: "reload", accelerator: "CmdOrCtrl+R" },
        // Note: forceReload is intentionally not bound — Cmd+Shift+R is
        // already the accelerator for File → Restart Server. Reload
        // (Cmd+R) is enough for refreshing the renderer; force-reload
        // is a niche dev-cache-busting need accessible from the menu.
        { role: "forceReload" },
        { type: "separator" },
        {
          label: "Show / Hide Agents",
          accelerator: "CmdOrCtrl+Shift+A",
          click: () => triggerRenderer("document.getElementById('agents-toggle')?.click()"),
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "front" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "About Local Agent X",
          click: () => app.showAboutPanel(),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
      const t = value as DesktopSettings["theme"];
      applyNativeTheme(t);
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

  // App child windows ping us with their sampled body bg + a contrasting
  // symbol color so the native min/max/X overlay can be repainted to
  // match. Eliminates the "LAX-theme top bar over differently-themed
  // app content" seam — strip and overlay share whatever color the app
  // chose for itself. No-op on macOS (no titleBarOverlay) and for the
  // main window (its overlay is theme-driven, not content-driven).
  ipcMain.handle("report-chrome-tint", (event, color: string, symbolColor: string) => {
    if (process.platform === "darwin") return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win === mainWindow) return;
    try { win.setTitleBarOverlay({ color, symbolColor, height: 32 }); } catch { /* not available */ }
  });
}

// ── App Lifecycle ─────────────────────────────────────────

app.on("ready", async () => {
  saxConfig = loadSAXConfig();

  // Sync Windows' own chrome theme to our renderer's theme BEFORE the
  // window opens. Otherwise the OS paints the titleBarOverlay strip in
  // the system theme on first frame, producing a brief wrong-color
  // flash that some users see as a permanent mismatch until they
  // toggle theme manually (which calls setTitleBarOverlay and forces
  // a repaint).
  applyNativeTheme(getSetting("theme"));

  // Native macOS menu — gated to darwin internally. Sets the app-wide
  // application menu containing New Session, Restart Server, Show/Hide
  // Agents, etc. — the actions that used to live in the JS-injected
  // in-window titlebar (which we skip on Mac).
  setupApplicationMenu();

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
