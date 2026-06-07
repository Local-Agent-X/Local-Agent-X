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
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getProjectRoot, getLAXConfig, reloadLAXConfig, type LAXConfig } from "./config";
import { isPidAlive, isOurServerProcess } from "./pid-probe";

const PID_FILE = join(homedir(), ".lax", "server.pid");

interface ServerPidFile {
  pid: number;
  parentPid?: number;
  startedAt: string;
}

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
}

let serverProcess: ChildProcess | null = null;
let isQuitting = false;
let isRestarting = false;
let crashHandler: ServerEventHandlers["onCrash"] | undefined;
let alreadyRunningHandler: ServerEventHandlers["onAlreadyRunning"] | undefined;

export function setQuitting(v: boolean): void { isQuitting = v; }
export function setRestarting(v: boolean): void { isRestarting = v; }
export function isQuittingFlag(): boolean { return isQuitting; }
export function getServerPid(): number | null { return serverProcess?.pid ?? null; }

function readServerPidFile(): ServerPidFile | null {
  if (!existsSync(PID_FILE)) return null;
  try { return JSON.parse(readFileSync(PID_FILE, "utf-8")) as ServerPidFile; }
  catch { return null; }
}

// True when dist/index.js exists and no source file is newer than it — i.e.
// the compiled build reflects current source and is safe to run instead of
// tsx. `npm run build` runs a full (non-incremental) tsc, so dist/index.js's
// mtime reliably marks the last build. Walks src for the first .ts newer than
// that and short-circuits, so the common fresh-build case is a cheap stat
// sweep (metadata only — not the content reads Defender scans).
function distIsFresh(projectRoot: string): boolean {
  const distIndex = join(projectRoot, "dist", "index.js");
  if (!existsSync(distIndex)) return false;
  const distMtime = statSync(distIndex).mtimeMs;
  const stack = [join(projectRoot, "src")];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.name.endsWith(".ts")) continue;
      if (statSync(p).mtimeMs > distMtime) return false;
    }
  }
  return true;
}

function killPidTree(pid: number): void {
  if (process.platform === "win32") {
    try { execSync(`taskkill /PID ${pid} /T /F`, { windowsHide: true, stdio: "ignore" }); } catch {}
  } else {
    try { process.kill(pid, "SIGTERM"); } catch {}
    setTimeout(() => { try { process.kill(pid, "SIGKILL"); } catch {} }, 1000);
  }
}

// Detect and kill orphan server processes left over from a previous
// Electron that died abnormally (force-kill, crash, power-off). Without
// this, Electron would silently attach to whatever was already on the
// port — including a stale server running pre-update code.
//
// A pidfile pointing at a dead-or-recycled PID (typical case after a
// reboot — Windows reassigns the number to an unrelated process) is
// stale: delete it and return so the next stage spawns cleanly. Without
// the delete, the server child reads the same stale file and exits with
// "refusing to start", looping the launcher forever.
export async function reclaimOrphanServer(): Promise<boolean> {
  const file = readServerPidFile();
  if (!file) return false;
  if (file.parentPid === process.pid) return false; // somehow ours
  if (!isOurServerProcess(file.pid)) {
    try { unlinkSync(PID_FILE); } catch {}
    return false;
  }
  console.warn(`[desktop] Killing orphan server pid=${file.pid} (parentPid=${file.parentPid ?? "n/a"}, current Electron=${process.pid}).`);
  killPidTree(file.pid);
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (!isPidAlive(file.pid)) break;
  }
  try { unlinkSync(PID_FILE); } catch {}
  return true;
}

export async function isServerRunning(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://127.0.0.1:${getLAXConfig().port}/api/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

// 60s ceiling. Cold server boot on a fresh Mac install legitimately takes
// 15-30s (tsx cold start + ari kernel + sqlite migrations + ollama daemon
// check + mxbai-embed-large pull on first run + MCP filesystem connect).
// Renderer-side retry (did-fail-load handler in createWindow) is the
// actual fix for the chrome-error race; this bump removes the noisy
// "server didn't start" notification when the server is just slow.
export async function waitForServer(maxWaitMs = 60000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await isServerRunning()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export function startServer(handlers?: ServerEventHandlers): void {
  if (serverProcess) return;
  if (handlers?.onCrash) crashHandler = handlers.onCrash;
  if (handlers?.onAlreadyRunning) alreadyRunningHandler = handlers.onAlreadyRunning;

  // Read PROJECT_ROOT live — project-root-resolver.ts can mutate it at
  // app.ready via setProjectRoot() when auto-discovery or the user picker
  // resolves a path. A `const PROJECT_ROOT` import would have snapshotted
  // the module-load value and missed the post-resolver update.
  const projectRoot = getProjectRoot();
  if (!projectRoot) {
    const reason =
      "PROJECT_ROOT could not be resolved. Edit ~/.lax/config.json so projectRoot points at your Local-Agent-X repo, then relaunch.";
    console.error(`[desktop] ${reason}`);
    try { handlers?.onStartupFailure?.({ reason }); } catch {}
    return;
  }

  // Run the compiled dist when the build is current (fast: no tsx transpile),
  // else tsx-from-source. distIsFresh guarantees we never run a dist that's
  // behind source, so the speedup costs us nothing in correctness.
  const srcIndex = join(projectRoot, "src", "index.ts");
  if (!existsSync(srcIndex)) {
    const reason =
      `src/index.ts not found at ${srcIndex}. Either projectRoot in ~/.lax/config.json points at the wrong place, or this repo is incomplete.`;
    console.error(`[desktop] ${reason}`);
    try { handlers?.onStartupFailure?.({ reason }); } catch {}
    return;
  }
  const useDist = distIsFresh(projectRoot);
  const nodeArgs = useDist
    ? ["--max-old-space-size=4096", join(projectRoot, "dist", "index.js")]
    : ["--max-old-space-size=4096", "--import=tsx", srcIndex];

  // GUI-launched Mac apps (Finder/Launchpad/Spotlight) inherit a minimal
  // PATH that excludes Homebrew, nvm, and asdf. Augment so `node` resolves
  // whether the user installed it via brew (arm64 or intel), nvm, or
  // system pkg.
  const PATH_AUGMENTS = [
    "/opt/homebrew/bin", "/opt/homebrew/sbin",
    "/usr/local/bin", "/usr/local/sbin",
    join(homedir(), ".nvm/versions/node/current/bin"),
  ];
  const existingPath = (process.env.PATH || "").split(":");
  const augmentedPath = [...PATH_AUGMENTS, ...existingPath].filter((p, i, a) => p && a.indexOf(p) === i).join(":");

  console.log(`[desktop] Starting LAX server (${useDist ? "compiled dist" : "tsx"})...`);
  // LAX_BUNDLED_MODELS_DIR points the server at electron-builder's
  // extraResources directory so whisper-model-fetch can find the
  // pre-bundled tiny.en files before falling back to download. In dev
  // (npm run dev / direct tsx), this is unset and the server falls back
  // to ~/.lax/models normally.
  const electron = require("electron") as typeof import("electron");
  const bundledModelsDir = electron.app.isPackaged ? process.resourcesPath : "";

  serverProcess = spawn("node", nodeArgs, {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    // LAX_PARENT_PID lets the server self-terminate via heartbeat if we
    // die abnormally; server.pid handshake catches the cases that slip
    // through libuv's Job Object cleanup on Windows.
    env: {
      ...process.env,
      PATH: augmentedPath,
      LAX_PARENT_PID: String(process.pid),
      // OS Documents path. May be OneDrive-redirected on Windows (Known Folder
      // Move); the server sanitizes that to the real on-disk ~/Documents — a
      // high-write agent workspace must not live under OneDrive. See config.ts.
      LAX_DOCUMENTS_DIR: electron.app.getPath("documents"),
      ...(bundledModelsDir ? { LAX_BUNDLED_MODELS_DIR: bundledModelsDir } : {}),
    },
    windowsHide: true,
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
    const forceKill = setTimeout(() => {
      if (pid && process.platform === "win32") {
        try { execSync(`taskkill /PID ${pid} /T /F`, { windowsHide: true, stdio: "ignore" }); } catch {}
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
    try { proc.kill("SIGTERM"); } catch {}
  });
}
