// LAX server child-process lifecycle. Prefers the compiled dist/index.js
// (plain node) over src/index.ts (tsx) WHEN the build is current — node
// skips tsx's per-file transpile, which on a Defender-heavy Windows box cost
// ~17s of cold start. "Current" means no source file is newer than the
// compiled entry; the instant anyone edits or pulls src ahead of dist we fall
// back to tsx, so the running code can never silently drift from source (the
// "I changed source but stale code runs" class this used to avoid by always
// using tsx). Same invariant, without paying transpile on every clean boot.
//
// Pid handshake (server.pid handshake + LAX_PARENT_PID env) makes orphan
// detection load-bearing: Electron crash / force-kill leaves the server
// running; next launch's reclaimOrphanServer() kills it before respawn so
// we never silently attach to stale pre-update code.

import { ChildProcess, spawn, execSync } from "child_process";
import { attachServerBridge } from "./server-bridge";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getProjectRoot, reloadLAXConfig, type LAXConfig } from "./config";
import { PID_FILE, readServerPidFile, waitForServer } from "./server-probe";
import { checkNodeFloor, type NodeFloorStatus } from "./node-floor";
import { serverDistIsFresh } from "./dist-freshness";

export { reclaimOrphanServer, isServerRunning, waitForServer } from "./server-probe";

export interface ServerEventHandlers {
  /** Fired when the server process exits uncleanly (non-zero code or
   *  signal). Caller usually forwards to the renderer to clear the
   *  "typing" indicator + surface a banner. */
  onCrash?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  /** Fired when startServer() refuses to spawn — e.g. PROJECT_ROOT is
   *  unset, or src/index.ts is missing. Without this the failure used
   *  to be a console.error to a /dev/null stdout and the splash hung
   *  forever. Caller surfaces this on the splash so the user sees what
   *  went wrong and how to fix it. */
  onStartupFailure?: (info: { reason: string }) => void;
  /** Fired when the server child exits with code 75 (EX_TEMPFAIL),
   *  which src/lifecycle.ts uses to signal "another LAX server already
   *  owns the pidfile — refuse to start". This is NOT a crash; the
   *  default 3s-restart loop would hit the same refusal forever. The
   *  splash should ask the user to kill the stale server. */
  onAlreadyRunning?: (info: { competingPid?: number; pidfilePath: string }) => void;
  /** Fired when the PATH-resolved `node` is below the project's
   *  engines.node floor (or missing). The spawn is refused — updated app
   *  code on an outdated runtime fails confusingly mid-boot. Caller offers
   *  the one-click upgrade (node-floor.ts promptAndUpgradeNode) and retries
   *  startServer() on success. */
  onNodeTooOld?: (status: NodeFloorStatus) => void;
}

let serverProcess: ChildProcess | null = null;
let isQuitting = false;
let isRestarting = false;
let crashHandler: ServerEventHandlers["onCrash"] | undefined;
let alreadyRunningHandler: ServerEventHandlers["onAlreadyRunning"] | undefined;
let startupFailureHandler: ServerEventHandlers["onStartupFailure"] | undefined;
let nodeTooOldHandler: ServerEventHandlers["onNodeTooOld"] | undefined;
// Rapid-crash-loop tracking: when the spawn happened, and how many
// consecutive spawns died within seconds. See the exit handler below.
let lastSpawnAt = 0;
let rapidCrashes = 0;

export function setQuitting(v: boolean): void { isQuitting = v; }
export function setRestarting(v: boolean): void { isRestarting = v; }
export function isQuittingFlag(): boolean { return isQuitting; }
export function getServerPid(): number | null { return serverProcess?.pid ?? null; }

// GUI-launched Mac apps (Finder/Launchpad/Spotlight) inherit a minimal
// PATH that excludes Homebrew, nvm, and asdf. Augment so `node` resolves
// whether the user installed it via brew (arm64 or intel), nvm, or system
// pkg. Exported so the node-floor check and upgrade resolve the SAME node
// this module will spawn.
export function buildAugmentedPath(): string {
  const PATH_AUGMENTS = [
    "/opt/homebrew/bin", "/opt/homebrew/sbin",
    "/usr/local/bin", "/usr/local/sbin",
    join(homedir(), ".nvm/versions/node/current/bin"),
  ];
  const existingPath = (process.env.PATH || "").split(":");
  return [...PATH_AUGMENTS, ...existingPath].filter((p, i, a) => p && a.indexOf(p) === i).join(":");
}

export function startServer(handlers?: ServerEventHandlers): void {
  if (serverProcess) return;
  if (handlers?.onCrash) crashHandler = handlers.onCrash;
  if (handlers?.onAlreadyRunning) alreadyRunningHandler = handlers.onAlreadyRunning;
  if (handlers?.onStartupFailure) startupFailureHandler = handlers.onStartupFailure;
  if (handlers?.onNodeTooOld) nodeTooOldHandler = handlers.onNodeTooOld;

  // Read PROJECT_ROOT live — project-root-resolver.ts can mutate it at
  // app.ready via setProjectRoot() when auto-discovery or the user picker
  // resolves a path. A `const PROJECT_ROOT` import would have snapshotted
  // the module-load value and missed the post-resolver update.
  const projectRoot = getProjectRoot();
  if (!projectRoot) {
    const reason =
      "PROJECT_ROOT could not be resolved. Edit ~/.lax/config.json so projectRoot points at your Local-Agent-X repo, then relaunch.";
    console.error(`[desktop] ${reason}`);
    try { startupFailureHandler?.({ reason }); } catch {}
    return;
  }

  // Run the compiled dist when the build is current (fast: no tsx transpile),
  // else tsx-from-source. serverDistIsFresh guarantees we never run a dist
  // that's behind source, so the speedup costs us nothing in correctness.
  const srcIndex = join(projectRoot, "src", "index.ts");
  if (!existsSync(srcIndex)) {
    const reason =
      `src/index.ts not found at ${srcIndex}. Either projectRoot in ~/.lax/config.json points at the wrong place, or this repo is incomplete.`;
    console.error(`[desktop] ${reason}`);
    try { startupFailureHandler?.({ reason }); } catch {}
    return;
  }
  const useDist = serverDistIsFresh(projectRoot);
  const nodeArgs = useDist
    ? ["--max-old-space-size=4096", join(projectRoot, "dist", "index.js")]
    : ["--max-old-space-size=4096", "--import=tsx", srcIndex];

  const augmentedPath = buildAugmentedPath();

  // Node floor: refuse to spawn updated app code on a runtime below the
  // project's engines.node — it would die confusingly mid-boot (or on the
  // first newer-syntax module). The handler offers a one-click in-app
  // upgrade and calls startServer() again on success.
  const nodeFloor = checkNodeFloor(projectRoot, augmentedPath);
  if (!nodeFloor.ok) {
    console.error(`[desktop] node on PATH is ${nodeFloor.foundMajor === -1 ? "missing" : `v${nodeFloor.foundMajor}`}, engines floor is ${nodeFloor.requiredMajor} — refusing to spawn`);
    try { nodeTooOldHandler?.(nodeFloor); } catch {}
    return;
  }

  console.log(`[desktop] Starting LAX server (${useDist ? "compiled dist" : "tsx"})...`);
  // LAX_BUNDLED_MODELS_DIR points the server at electron-builder's
  // extraResources directory so whisper-model-fetch can find the
  // pre-bundled tiny.en files before falling back to download. In dev
  // (npm run dev / direct tsx), this is unset and the server falls back
  // to ~/.lax/models normally.
  const electron = require("electron") as typeof import("electron");
  const bundledModelsDir = electron.app.isPackaged ? process.resourcesPath : "";

  lastSpawnAt = Date.now();

  // We spawn a real `node` (PATH-resolved) rather than the bundled Electron
  // binary via ELECTRON_RUN_AS_NODE: the server loads native addons
  // (better-sqlite3, sqlite-vec, sherpa-onnx) built against the system Node
  // ABI by the repo's own `npm install`. Electron's embedded Node has a
  // different NODE_MODULE_VERSION, so running the server under it would crash
  // on the first native require. Pinning to process.execPath is therefore
  // unsafe here; the PATH augment above stays. (R4-08: config-sourced spawn
  // cwd is now validated for ownership in config.ts.)
  serverProcess = spawn("node", nodeArgs, {
    cwd: projectRoot,
    // fd 3 = 'ipc': lets the server child request native OS actions (trashItem,
    // so deletes get real Put Back / Restore) that only Electron main can do.
    // See attachServerBridge below.
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    // LAX_PARENT_PID lets the server self-terminate via heartbeat if we
    // die abnormally; server.pid handshake catches the cases that slip
    // through libuv's Job Object cleanup on Windows.
    env: {
      ...process.env,
      PATH: augmentedPath,
      LAX_PARENT_PID: String(process.pid),
      LAX_DESKTOP_BRIDGE: "1",
      // OS Documents path. May be OneDrive-redirected on Windows (Known Folder
      // Move); the server sanitizes that to the real on-disk ~/Documents — a
      // high-write agent workspace must not live under OneDrive. See config.ts.
      LAX_DOCUMENTS_DIR: electron.app.getPath("documents"),
      ...(bundledModelsDir ? { LAX_BUNDLED_MODELS_DIR: bundledModelsDir } : {}),
    },
    windowsHide: true,
  });

  attachServerBridge(serverProcess, {
    // Agent self-restart over messaging (restart / apply_update tools). Restart
    // the server child for code-only changes; relaunch all of Electron after an
    // update (it can include desktop/ main-process changes a child restart
    // can't reload). restartServer is hoisted (declared below).
    onRestartServer: () => { void restartServer(); },
    onRelaunchApp: () => {
      const e = require("electron") as typeof import("electron");
      e.app.relaunch();
      e.app.quit();
    },
  });

  // Tee server stdout/stderr to a real file. Electron's GUI-launched
  // main-process console is /dev/null, so any crash-loop output is invisible
  // unless we persist it. File is opened append so successive respawns
  // accumulate (with a START marker so you can find the latest boot).
  const stdioLogPath = join(homedir(), ".lax", "logs", "desktop-stdio.log");
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    fs.mkdirSync(join(homedir(), ".lax", "logs"), { recursive: true });
    const stdioStream = fs.createWriteStream(stdioLogPath, { flags: "a" });
    stdioStream.write(`\n\n══ START boot pid=${serverProcess.pid} at ${new Date().toISOString()} ══\n`);
    serverProcess.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      stdioStream.write(text);
      const line = text.trim();
      if (line) console.log("[server]", line);
    });
    serverProcess.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stdioStream.write(text);
      const line = text.trim();
      if (line) console.error("[server]", line);
    });
  } catch {
    serverProcess.stdout?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.log("[server]", line);
    });
    serverProcess.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.error("[server]", line);
    });
  }

  serverProcess.on("exit", (code, signal) => {
    // Exit classification:
    //   code === 0           : clean shutdown (rare except via tray Quit)
    //   code === 75          : EX_TEMPFAIL from src/lifecycle.ts — another
    //                          LAX server already owns the pidfile. NOT a
    //                          crash; auto-restart would hit the same
    //                          refusal forever. Surface to splash instead.
    //   code !== 0 (other)   : server threw, hit OOM, or process.exit(1)
    //   signal === "SIGKILL" : OS killed it (often OOM via macOS jetsam)
    const wasUnclean = code !== 0 || signal != null;
    console.log(`[desktop] Server exited code=${code} signal=${signal}`);
    serverProcess = null;

    if (code === 75 && !isQuitting && !isRestarting) {
      const competing = readServerPidFile();
      try {
        alreadyRunningHandler?.({
          competingPid: competing?.pid,
          pidfilePath: PID_FILE,
        });
      } catch {}
      return; // Do NOT auto-restart — same refusal will happen.
    }

    if (wasUnclean && !isQuitting && !isRestarting && crashHandler) {
      try { crashHandler({ code, signal }); } catch { /* renderer may already be gone */ }
    }

    // Rapid-crash-loop breaker. A server that dies within seconds of every
    // spawn (broken dist, missing dep, bad migration) used to restart every
    // 3s forever while the splash polled /api/health until the end of time —
    // the 2026-06-09 stale-dist import crash hung the splash exactly this
    // way. Three consecutive sub-20s unclean exits ⇒ stop restarting and
    // surface the recovery screen instead.
    rapidCrashes = wasUnclean && Date.now() - lastSpawnAt < 20_000 ? rapidCrashes + 1 : 0;
    if (rapidCrashes >= 3 && !isQuitting && !isRestarting) {
      const reason =
        `Server crashed ${rapidCrashes} times in a row right after starting ` +
        `(last exit: code=${code} signal=${signal ?? "none"}). This usually means a broken ` +
        `build — check ~/.lax/logs/server.log, then Repair or update again.`;
      console.error(`[desktop] ${reason}`);
      try { startupFailureHandler?.({ reason }); } catch {}
      return; // Do NOT auto-restart — the next spawn would crash the same way.
    }

    if (!isQuitting && !isRestarting) {
      setTimeout(() => {
        if (!isQuitting && !isRestarting && !serverProcess) startServer();
      }, 3000);
    }
  });
}

// Stop + wait + reload config + start + wait-for-ready. Single source of
// truth for "restart the server" so the menu (File → Restart Server) and
// the IPC handler (renderer button) can't drift.
//
// History: the menu used to call stopServer() + startServer() inline
// without setRestarting / config reload / waitForServer / URL reload.
// Result: server actually restarted but the renderer kept polling the
// old (now-dead) URL and looked frozen. The IPC handler had the full
// sequence; the menu didn't. Both now route through here.
//
// Callers handle the post-ready URL reload themselves (so this module
// doesn't need to know about BrowserWindow).
export async function restartServer(): Promise<{ ready: boolean; cfg: LAXConfig }> {
  setRestarting(true);
  await stopServer();
  // Brief pause — child process exit doesn't synchronously release the
  // port on all platforms; without this the new spawn occasionally
  // fails with EADDRINUSE.
  await new Promise(r => setTimeout(r, 1000));
  const cfg = reloadLAXConfig();
  console.log(`[desktop] Restarting on port ${cfg.port}`);
  startServer();
  setRestarting(false);
  const ready = await waitForServer();
  return { ready, cfg };
}

export function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!serverProcess) { resolve(); return; }
    console.log("[desktop] Stopping LAX server (pid: " + serverProcess.pid + ")...");
    const proc = serverProcess;
    const pid = proc.pid;
    // Windows: SIGTERM emulation is TerminateProcess on the DIRECT child
    // only — no JS handler runs, and the node server's own children (tsx
    // transpiler, esbuild service) survive as orphans. There is no graceful
    // value to preserve, so tree-kill immediately. This orphan tree is how
    // a quit-and-relaunched app kept reattaching to a server running
    // hours-old code (2026-06-09: five process generations in one day).
    if (process.platform === "win32") {
      if (pid) {
        try { execSync(`taskkill /PID ${pid} /T /F`, { windowsHide: true, stdio: "ignore" }); } catch {}
      }
      serverProcess = null;
      resolve();
      return;
    }
    const forceKill = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      serverProcess = null;
      resolve();
    }, 2000);
    proc.on("exit", () => {
      clearTimeout(forceKill);
      serverProcess = null;
      resolve();
    });
    try { proc.kill("SIGTERM"); } catch {}
  });
}

/** Synchronous, unconditional server-tree kill for app-exit paths.
 *  Electron does NOT await async listeners on `will-quit` — the main
 *  process exits before a Promise-based stop runs its force-kill timer,
 *  which is exactly how servers survived every tray quit and kept serving
 *  stale in-memory code. Windows tree-kills synchronously; POSIX sends
 *  SIGTERM and lets the LAX_PARENT_PID heartbeat reap anything that
 *  lingers after we're gone. */
export function stopServerSync(): void {
  const proc = serverProcess;
  if (!proc?.pid) return;
  console.log(`[desktop] Sync-stopping LAX server (pid: ${proc.pid})...`);
  if (process.platform === "win32") {
    try { execSync(`taskkill /PID ${proc.pid} /T /F`, { windowsHide: true, stdio: "ignore" }); } catch {}
  } else {
    try { proc.kill("SIGTERM"); } catch {}
  }
  serverProcess = null;
}
