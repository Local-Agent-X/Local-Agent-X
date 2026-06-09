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

import { loadLAXConfig, reloadLAXConfig, getLAXConfig, ICON_PATH, PROJECT_ROOT, PROJECT_ROOT_ERROR, getProjectRoot } from "./config";
import { resolveAndPersistProjectRoot } from "./project-root-resolver";
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
import { createWindow, getMainWindow, isStuckOnSplash, showWindow, toggleWindow, prewarmAppWindow } from "./window";
import { setupApplicationMenu } from "./app-menu";
import { registerHotkey, showNotification } from "./hotkey-notifications";
import { setupIPC } from "./ipc";
import { createTray, destroyTray } from "./tray";
import { registerAutostart } from "./autostart";
import { runReconcile } from "./reconcile";
import { shutdownNativeSpeech } from "./native-speech";

// Encode an arbitrary string as a JS string literal that is safe to embed in
// code handed to executeJavaScript. JSON.stringify alone leaves U+2028/U+2029
// (legal in JSON, but a syntax error inside a JS source string) and `<`
// (which can form `</script>` / `<!--`) unescaped.
function jsLiteral(s: string): string {
  return JSON.stringify(s)
    .replace(/ /g, "\\u2028")
    .replace(/ /g, "\\u2029")
    .replace(/</g, "\\u003C");
}

// Push status text into the splash. Splash markup lives in splash.ts —
// targets .status (main line) and #h (sub-hint). Failures are swallowed:
// the splash may have already navigated away to the real app.
function setSplashStatus(text: string): void {
  const w = getMainWindow();
  if (!w || w.isDestroyed()) return;
  const safe = jsLiteral(text);
  w.webContents.executeJavaScript(
    `(()=>{const e=document.querySelector('.status');if(e)e.textContent=${safe};})()`
  ).catch(() => {});
}
function setSplashHint(text: string): void {
  const w = getMainWindow();
  if (!w || w.isDestroyed()) return;
  const safe = jsLiteral(text);
  // Also clearInterval the splash's 1s ticker — otherwise its s===15 /
  // s===45 branches overwrite our hint with the default "Warming up…" /
  // "Still loading…" text a few seconds later. (splash.ts captures the
  // handle on window.__laxSplashTimer for exactly this reason.)
  w.webContents.executeJavaScript(
    `(()=>{const e=document.getElementById('h');if(e){e.textContent=${safe};e.classList.add('show');}if(window.__laxSplashTimer){clearInterval(window.__laxSplashTimer);window.__laxSplashTimer=null;}})()`
  ).catch(() => {});
}

// Fatal boot error → swap the spinner for action buttons (Repair / Open
// Logs / Quit). One universal recovery affordance that covers every
// stuck-splash class (reconcile failure, server start failure, pidfile
// conflict, internal errors) without enumerating individual causes —
// the Repair button wipes the state files boot depends on and relaunches,
// which fixes the entire class. Buttons live in splash.ts; their clicks
// navigate to lax://repair etc., intercepted below in createWindow's
// will-navigate handler installation.
function showSplashRecovery(status: string, hint: string): void {
  setSplashStatus(status);
  setSplashHint(hint);
  const w = getMainWindow();
  if (!w || w.isDestroyed()) return;
  w.webContents.executeJavaScript("window.__laxShowRecovery&&window.__laxShowRecovery()").catch(() => {});
}

// Intercept lax://<action> clicks from the splash recovery buttons.
// data: URLs can't reach IPC (no preload), so the buttons just navigate
// to a custom scheme and we catch will-navigate. preventDefault keeps
// the renderer from chrome-erroring; we then route to the action.
function setupSplashRecoveryIntercept(): void {
  const w = getMainWindow();
  if (!w || w.isDestroyed()) return;
  w.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("lax://")) return;
    e.preventDefault();
    const action = url.slice("lax://".length).replace(/\/+$/, "");
    handleRecoveryAction(action);
  });
}

function handleRecoveryAction(action: string): void {
  if (action === "quit") {
    setQuitting(true);
    app.quit();
    return;
  }
  if (action === "logs") {
    const fs = require("node:fs") as typeof import("node:fs");
    const logPath = join(require("os").homedir(), ".lax", "logs", "desktop-stdio.log");
    if (fs.existsSync(logPath)) {
      require("electron").shell.openPath(logPath);
    } else {
      require("electron").shell.openPath(join(require("os").homedir(), ".lax"));
    }
    return;
  }
  if (action === "repair") {
    // Wipe the state files that boot depends on. Each one corresponds to
    // a stuck-splash failure class:
    //   reconcile-state.json → reconcile thinks code is mismatched and
    //                          retries npm install/build on every boot
    //   server.pid           → "Server already running" (orphan claim)
    // We deliberately do NOT wipe config.json (port + authToken) — losing
    // those forces a fresh handshake that breaks any pinned/bookmarked
    // URLs the user has, and the user almost certainly doesn't want that.
    const fs = require("node:fs") as typeof import("node:fs");
    const lax = join(require("os").homedir(), ".lax");
    for (const file of ["reconcile-state.json", "server.pid"]) {
      try { fs.unlinkSync(join(lax, file)); } catch { /* not present — fine */ }
    }
    console.log(`[desktop] repair: wiped reconcile-state.json + server.pid, relaunching`);
    app.relaunch();
    app.exit(0);
    return;
  }
  console.warn(`[desktop] unknown recovery action: ${action}`);
}

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
// The sandboxed audio service can't load third-party virtual audio drivers
// (Steam Streaming Microphone, VB-Cable, OBS, NVIDIA Broadcast, …), so
// getUserMedia silently captured nothing from them in the desktop app even
// though the same device works in a normal browser. Disabling the audio
// sandbox lets the audio process reach those devices. Out-of-process audio
// stays on (only the sandbox is dropped), so the blast radius is small.
app.commandLine.appendSwitch("disable-features", "AudioServiceSandbox");
// permission-request handler in app.ready controls media grants explicitly.

app.on("ready", async () => {
  loadLAXConfig();

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
  const APP_ORIGIN = `http://127.0.0.1:${getLAXConfig().port}`;

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

  // Single-instance lock with stuck-holder displacement. The baseline
  // Electron pattern (lock-fails → app.quit) assumes the existing holder
  // is healthy. When the existing holder is hung on the splash — failed
  // reconcile, dead server, etc. — that pattern strands the user with no
  // way out: every shortcut click silently quits the new launch while
  // the broken instance keeps the lock. The user thinks the app is dead.
  //
  // Fix is two-sided:
  //   • New launch (here): pass a {tag:"shortcut-relaunch"} payload to
  //     signal "I'm a deliberate user retry, yield if you're stuck." On
  //     lock-fail, poll briefly (3s) for the lock in case the old
  //     instance is in the middle of exiting.
  //   • Old launch (second-instance handler below): if we receive the
  //     yield-signal AND we've been on the splash past a 10s grace
  //     period, exit so the new launch can take over. Outside the grace
  //     window or once we've navigated to the real app, just focus.
  const LOCK_PAYLOAD = { tag: "shortcut-relaunch" } as const;
  const STUCK_GRACE_MS = 10_000;
  const LOCK_RETRY_DEADLINE_MS = 3_000;
  const LOCK_RETRY_DELAY_MS = 250;

  let gotLock = app.requestSingleInstanceLock(LOCK_PAYLOAD);
  if (!gotLock) {
    const retryDeadline = Date.now() + LOCK_RETRY_DEADLINE_MS;
    while (!gotLock && Date.now() < retryDeadline) {
      await new Promise((r) => setTimeout(r, LOCK_RETRY_DELAY_MS));
      gotLock = app.requestSingleInstanceLock(LOCK_PAYLOAD);
    }
    if (!gotLock) {
      // Existing holder is responsive (didn't yield within the grace
      // window). Quit and let it handle the user.
      app.quit();
      return;
    }
    console.log("[desktop] took over from a stuck previous instance");
  }

  app.on("second-instance", (_event, _argv, _cwd, additionalData) => {
    const data = additionalData as { tag?: string } | undefined;
    const isShortcutRelaunch = data?.tag === "shortcut-relaunch";
    if (isShortcutRelaunch && isStuckOnSplash(STUCK_GRACE_MS)) {
      console.warn(
        "[desktop] second-instance fired while still on splash past grace period — " +
        "yielding to the new launch (user's shortcut click is the recovery signal).",
      );
      setQuitting(true);
      app.exit(0);
      return;
    }
    showWindow();
  });

  setupIPC();

  // Show splash early — reconcile may take 30s+ if deps changed, and a
  // blank screen during that time would feel like a hang. createWindow()
  // also kicks off the /api/health poll-and-navigate which waits patiently
  // until startServer() (below) makes the server respond.
  createWindow();
  setupSplashRecoveryIntercept();

  // PROJECT_ROOT is null when packaged + ~/.lax/config.json's projectRoot
  // field is unset or points somewhere without src/index.ts. Self-heal:
  // (1) auto-discover common install paths (~/Projects/Local-Agent-X etc.)
  // (2) if not found, show a dialog with "Browse folder…" / "Open download
  //     page" / "Quit"
  // (3) if user opts out, fall through to the splash error so they still
  //     see what's wrong.
  // After this block, the live config.getProjectRoot() returns the resolved
  // path — startServer + reconcile use that getter, not the module-load
  // const PROJECT_ROOT.
  if (!PROJECT_ROOT) {
    console.warn(`[desktop] ${PROJECT_ROOT_ERROR} — attempting self-heal`);
    setSplashStatus("Looking for source code…");
    const resolved = await resolveAndPersistProjectRoot();
    if (!resolved) {
      console.error(`[desktop] self-heal aborted — user opted out or no valid folder`);
      showSplashRecovery("Configuration error", PROJECT_ROOT_ERROR ?? "PROJECT_ROOT not resolved");
      return;
    }
    console.log(`[desktop] self-heal resolved projectRoot=${resolved}`);
    setSplashStatus("Starting…");
  }
  // Beyond this point getProjectRoot() returns a valid path. Reconcile
  // uses it directly via the projectRoot arg below.
  const liveProjectRoot = getProjectRoot();
  if (!liveProjectRoot) {
    // Defensive — resolveAndPersistProjectRoot returned a value but the
    // setter didn't take effect. Shouldn't happen; failsafe to splash.
    showSplashRecovery("Internal error", "PROJECT_ROOT setter did not propagate. Click Repair to clear state and relaunch.");
    return;
  }

  // Reconcile npm + desktop build BEFORE starting the server. Closes the
  // "I pulled new code but the app silently runs old/broken bits" failure
  // class: if package-lock.json changed we run `npm install`; if
  // desktop/src changed we rebuild and relaunch so dist/main.js is the
  // freshly-compiled one.
  try {
    const result = await runReconcile({
      projectRoot: liveProjectRoot,
      onStatus: setSplashStatus,
    });
    if (result.needsRelaunch) {
      console.log(`[desktop] reconcile rebuilt desktop/src — relaunching Electron`);
      app.relaunch();
      app.exit(0);
      return;
    }
    if (result.ranSteps.length > 0) {
      console.log(`[desktop] reconcile ran: ${result.ranSteps.join(", ")}`);
    }
  } catch (e) {
    const msg = (e as Error).message;
    const code = (e as NodeJS.ErrnoException).code;
    console.error(`[desktop] reconcile failed: ${msg}`);
    // Self-heal class: ENOENT means we couldn't even find `npm` to run the
    // reconcile step. That's "couldn't verify," not "code is broken" —
    // the .app's bundled dist/ is whatever shipped in the signed installer,
    // so booting it is safe. (The original hard-fail was meant to catch
    // package-lock-changed-but-install-failed mismatches; ENOENT predates
    // any code change.) Log + continue. Other reconcile errors (npm ran
    // but exited nonzero) still hard-fail because those indicate a real
    // mismatch between sources and built artifacts.
    if (code === "ENOENT" || /\bENOENT\b|spawn npm/i.test(msg)) {
      console.warn(`[desktop] reconcile skipped — npm not on PATH. Continuing with bundled dist/.`);
      setSplashStatus("Couldn't check for updates — continuing");
      setSplashHint("Install Node.js + npm to enable auto-update on launch.");
      // Fall through to normal boot.
    } else {
      showSplashRecovery("Update failed", msg.slice(0, 200));
      return; // Don't start the server with mismatched code.
    }
  }

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
      onStartupFailure: ({ reason }) => {
        // src/index.ts missing or PROJECT_ROOT null at spawn time. The
        // splash is currently showing — surface recovery so the user
        // can click Repair instead of staring at a frozen progress UI.
        showSplashRecovery("Server failed to start", reason);
      },
      onAlreadyRunning: ({ competingPid, pidfilePath }) => {
        // src/lifecycle.ts exited 75: another LAX server still owns
        // ~/.lax/server.pid. Auto-restart is intentionally suppressed
        // for this exit code (server-process.ts:exit handler) — the
        // refusal would just repeat. Repair button wipes server.pid +
        // relaunches, which fixes this without the user needing to know
        // about pidfiles.
        const hint = competingPid
          ? `Another LAX server is running (PID ${competingPid}). Repair will clear the pidfile and relaunch.`
          : `Another LAX server claims ${pidfilePath}. Repair will clear it and relaunch.`;
        showSplashRecovery("Server already running", hint);
      },
    });
  }

  // Spawn a hidden BrowserWindow now so the first pinned-app click reuses
  // an already-warm renderer instead of paying the cold-spawn cost. The
  // prewarm itself polls isServerRunning() — safe to call before the server
  // is fully up.
  prewarmAppWindow();

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
      const cfg = reloadLAXConfig();
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
  // (createWindow was called before reconcile so the splash showed during
  //  any npm install / desktop rebuild — don't call it again here.)

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
  shutdownNativeSpeech();
  stopServer();
  destroyTray();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !getSetting("closeToTray")) {
    setQuitting(true);
    app.quit();
  }
});
