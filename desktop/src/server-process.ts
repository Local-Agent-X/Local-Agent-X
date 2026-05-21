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
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { PROJECT_ROOT, getSAXConfig } from "./config";

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
}

let serverProcess: ChildProcess | null = null;
let isQuitting = false;
let isRestarting = false;
let crashHandler: ServerEventHandlers["onCrash"] | undefined;

export function setQuitting(v: boolean): void { isQuitting = v; }
export function setRestarting(v: boolean): void { isRestarting = v; }
export function isQuittingFlag(): boolean { return isQuitting; }
export function getServerPid(): number | null { return serverProcess?.pid ?? null; }

function readServerPidFile(): ServerPidFile | null {
  if (!existsSync(PID_FILE)) return null;
  try { return JSON.parse(readFileSync(PID_FILE, "utf-8")) as ServerPidFile; }
  catch { return null; }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
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
export async function reclaimOrphanServer(): Promise<boolean> {
  const file = readServerPidFile();
  if (!file) return false;
  if (!isPidAlive(file.pid)) return false;
  if (file.parentPid === process.pid) return false; // somehow ours
  console.warn(`[desktop] Killing orphan server pid=${file.pid} (parentPid=${file.parentPid ?? "n/a"}, current Electron=${process.pid}).`);
  killPidTree(file.pid);
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (!isPidAlive(file.pid)) break;
  }
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

  // Always run from src/index.ts via tsx. We deliberately do NOT prefer
  // a compiled dist/ even when present — that created a recurring "I
  // changed source but the running code is stale" class of bug. tsx adds
  // ~2s to cold start (negligible against the full boot) in exchange for
  // "what's on disk IS what runs" — structurally impossible for the two
  // to drift. `npm run build` still exists for packaging without source.
  const srcIndex = join(PROJECT_ROOT, "src", "index.ts");
  if (!existsSync(srcIndex)) {
    console.error(`[desktop] src/index.ts not found at ${srcIndex} — refusing to start`);
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
  serverProcess = spawn("node", nodeArgs, {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    // LAX_PARENT_PID lets the server self-terminate via heartbeat if we
    // die abnormally; server.pid handshake catches the cases that slip
    // through libuv's Job Object cleanup on Windows.
    env: { ...process.env, PATH: augmentedPath, LAX_PARENT_PID: String(process.pid) },
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
    // Crash classification:
    //   code === 0           : clean shutdown (rare except via tray Quit)
    //   code !== 0           : server threw, hit OOM, or process.exit(1)
    //   signal === "SIGKILL" : OS killed it (often OOM via macOS jetsam)
    const wasUnclean = code !== 0 || signal != null;
    console.log(`[desktop] Server exited code=${code} signal=${signal}`);
    serverProcess = null;
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
