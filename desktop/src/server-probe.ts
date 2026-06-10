// Stateless probes for the LAX server: pidfile reading, orphan
// reclamation, and health polling. Extracted from server-process.ts —
// nothing here touches the live ChildProcess handle, so these are safe to
// call from any module without ordering constraints.

import { execSync } from "child_process";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getLAXConfig } from "./config";
import { isPidAlive, isOurServerProcess } from "./pid-probe";

export const PID_FILE = join(homedir(), ".lax", "server.pid");

export interface ServerPidFile {
  pid: number;
  parentPid?: number;
  startedAt: string;
}

export function readServerPidFile(): ServerPidFile | null {
  if (!existsSync(PID_FILE)) return null;
  try { return JSON.parse(readFileSync(PID_FILE, "utf-8")) as ServerPidFile; }
  catch { return null; }
}

export function killPidTree(pid: number): void {
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
