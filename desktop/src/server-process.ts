// SAX server child-process lifecycle. Spawns src/index.ts via tsx so the
// running code is always what's on disk — deliberately NOT pointing at a
// compiled dist/index.js to eliminate the "I changed source but the
// running code is stale" failure class.
//
// Pid handshake (server.pid handshake + LAX_PARENT_PID env) makes orphan
// detection load-bearing: Electron crash / force-kill leaves the server
// running; next launch's reclaimOrphanServer() kills it before respawn so
// we never silently attach to stale pre-update code.

import { ChildProcess, spawn, execSync } from "child_process";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getProjectRoot, getSAXConfig } from "./config";
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
    const res = await fetch(`http://127.0.0.1:${getSAXConfig().port}/api/health`, {
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

  // Always run from src/index.ts via tsx. We deliberately do NOT prefer
  // a compiled dist/ even when present — that created a recurring "I
  // changed source but the running code is stale" class of bug. tsx adds
  // ~2s to cold start (negligible against the full boot) in exchange for
  // "what's on disk IS what runs" — structurally impossible for the two
  // to drift. `npm run build` still exists for packaging without source.
  const srcIndex = join(projectRoot, "src", "index.ts");
  if (!existsSync(srcIndex)) {
    const reason =
      `src/index.ts not found at ${srcIndex}. Either projectRoot in ~/.lax/config.json points at the wrong place, or this repo is incomplete.`;
    console.error(`[desktop] ${reason}`);
    try { handlers?.onStartupFailure?.({ reason }); } catch {}
    return;
  }
  const nodeArgs = ["--max-old-space-size=4096", "--import=tsx", srcIndex];

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

  console.log(`[desktop] Starting LAX server (tsx, ${srcIndex})...`);
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

export function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!serverProcess) { resolve(); return; }
    console.log("[desktop] Stopping SAX server (pid: " + serverProcess.pid + ")...");
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
