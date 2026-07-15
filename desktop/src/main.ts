/**
 * Local Agent X — Electron Main Process
 *
 * Entry point. Sets Chromium flags before app.ready, then wires the
 * extracted modules together in the ready handler. Implementation lives
 * in adjacent files (config, settings, theme, server-process, window,
 * app-menu, hotkey-notifications, ipc, tray, autostart).
 */

import { app, globalShortcut } from "electron";

import { loadLAXConfig, reloadLAXConfig, getLAXConfig, ICON_PATH, PROJECT_ROOT, PROJECT_ROOT_ERROR, getProjectRoot } from "./config";
import { resolveAndPersistProjectRoot } from "./project-root-resolver";
import { getSetting } from "./settings";
import { applyNativeTheme } from "./theme";
import {
  reclaimOrphanServer,
  isServerRunning,
  startServer,
  stopServer,
  stopServerSync,
  waitForServer,
  setQuitting,
  setRestarting,
} from "./server-process";
import { createWindow, getMainWindow, isStuckOnSplash, showWindow, toggleWindow, openAccountWindow } from "./window";
import { setupApplicationMenu } from "./app-menu";
import { registerHotkey, registerPanicHotkey, showNotification } from "./hotkey-notifications";
import { setupIPC } from "./ipc";
import { createTray, destroyTray } from "./tray";
import { registerAutostart } from "./autostart";
import { runReconcile, killReconcileStepsSync } from "./reconcile";
import { shutdownNativeSpeech } from "./native-speech";
import { setupSessionPermissions } from "./session-permissions";
import { initBrowserNetworkHardening } from "./browser-partition";
import {
  setSplashStatus,
  setSplashHint,
  showSplashRecovery,
  setupSplashRecoveryIntercept,
} from "./splash-recovery";

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
initBrowserNetworkHardening(); // QUIC/DoH off (app-wide, pre-ready) for browser-view partitions

app.on("ready", async () => {
  loadLAXConfig();

  // Sync Windows' own chrome theme to our renderer's theme BEFORE the
  // window opens. Otherwise Windows paints the titleBarOverlay strip in
  // the system theme on first frame, producing a brief wrong-color flash
  // that some users see as a permanent mismatch until they toggle theme
  // manually (which calls setTitleBarOverlay and forces a repaint).
  applyNativeTheme(getSetting("theme"));

  setupApplicationMenu(getMainWindow);

  setupSessionPermissions();

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

  // Self-recovery watchdog. pollAndNavigate now waits indefinitely for the
  // server (so a slow build never freezes us out), but a genuinely wedged
  // boot — server failed to bind, hung mid-init — must still give the user a
  // way out instead of an eternal spinner. After a grace well past a normal
  // boot, surface the canonical Repair/Logs/Quit affordance. The health poll
  // keeps running underneath, so a server that simply took a long time still
  // auto-navigates straight past this.
  const SPLASH_RECOVERY_GRACE_MS = 5 * 60_000;
  setTimeout(() => {
    if (isStuckOnSplash(SPLASH_RECOVERY_GRACE_MS)) {
      showSplashRecovery(
        "Still starting…",
        "This is taking longer than usual. It will continue automatically when the server responds — or click Repair to reset and relaunch.",
      );
    }
  }, SPLASH_RECOVERY_GRACE_MS);

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
    for (const w of result.warnings) {
      console.warn(`[desktop] reconcile warning: ${w}`);
      showNotification("Local Agent X — update warning", w);
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
    void startServer({
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
      onNodeTooOld: async (status) => {
        // System node is below the project's engines floor (or missing).
        // Offer the one-click in-app upgrade; on success startServer()
        // re-runs with the handlers already registered above.
        const { promptAndUpgradeNode } = await import("./node-floor");
        const result = await promptAndUpgradeNode(status);
        if (result.ok) void startServer();
        else showSplashRecovery("Node.js upgrade required", result.detail);
      },
      onNativeAbiMismatch: async () => {
        // A native addon was compiled against a different Node major than the
        // one we spawn. Rebuild it against the runtime node and retry, instead
        // of dead-ending at the repair screen. Same fix-then-retry shape as
        // onNodeTooOld; setSplashStatus keeps the spinner informative without
        // swapping in the recovery buttons mid-rebuild.
        const { setSplashStatus } = await import("./splash-recovery");
        const { rebuildNativeModules } = await import("./native-rebuild");
        setSplashStatus("Rebuilding native modules…");
        const result = await rebuildNativeModules();
        if (result.ok) void startServer();
        else showSplashRecovery(
          "Native modules need rebuilding",
          `${result.detail} Run \`npm rebuild better-sqlite3\` in the install directory, then relaunch.`,
        );
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

  createTray({
    iconPath: ICON_PATH,
    onShow: showWindow,
    onToggle: toggleWindow,
    onQuit: async () => {
      setQuitting(true);
      // Kill the server tree AND any in-flight reconcile build BEFORE
      // exiting so quit can never orphan either (an orphaned `npm run
      // build` keeps rewriting dist/ after we're gone — the next launch
      // then races it), then app.exit — quit-event roulette (a hung
      // native handler, a prevented close) must not be able to keep a
      // "quit" app alive. app.exit skips will-quit, so this path kills
      // reconcile steps itself.
      killReconcileStepsSync();
      await stopServer();
      destroyTray();
      app.exit(0);
    },
    onNewSession: () => {
      showWindow();
      getMainWindow()?.webContents.executeJavaScript("window.startNewSession?.()");
    },
    onConnectAccount: openAccountWindow,
    getServerStatus: isServerRunning,
    onRestartServer: async () => {
      setRestarting(true);
      await stopServer();
      await new Promise(r => setTimeout(r, 1000));
      const cfg = reloadLAXConfig();
      console.log("[desktop] Tray restart on port", cfg.port);
      await startServer();
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
  registerPanicHotkey();
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
  // MUST be the sync variant: Electron exits before async listeners finish,
  // so a Promise-based stop here never reaches its force-kill — the server
  // survived every quit and relaunches silently reattached to it. Same
  // story for an in-flight reconcile build: orphaned, it keeps writing
  // dist/ after we exit and the next launch races a half-rebuilt server.
  killReconcileStepsSync();
  stopServerSync();
  destroyTray();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !getSetting("closeToTray")) {
    setQuitting(true);
    app.quit();
  }
});
