/**
 * Global (cross-process) self_edit lock.
 *
 * A single PID-file lock at ~/.lax/self-edit-sandbox.lock serializes ALL
 * self_edit runs on this machine — sandboxed and bypass alike. The sandbox
 * path always took it; the bypass path (autopilot `_cwd` route, `_unsafe`
 * emergency rescues) historically did not, so an autopilot self_edit and a
 * chat `_unsafe` self_edit could build/install into the shared node_modules
 * concurrently and corrupt each other. Both paths now go through here, so at
 * most one self_edit touches the shared tree at a time.
 *
 * This is distinct from the per-session lock in session-lock.ts, which only
 * prevents a single chat session from firing overlapping calls. This lock is
 * process-wide and survives across sessions / autopilot / restarts.
 */

import { writeFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";

const SANDBOX_LOCK = join(getLaxDir(), "self-edit-sandbox.lock");

export interface LockHolder {
  pid: number;
  startedAt: string;
}

export interface LockResult {
  acquired: boolean;
  holder?: LockHolder;
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Acquire the global self_edit lock. Reclaims a stale lock whose holder PID
 *  is dead or whose file is corrupt. Returns acquired=false (with the live
 *  holder) when another live process holds it. */
export function acquireGlobalSelfEditLock(): LockResult {
  mkdirSync(getLaxDir(), { recursive: true, mode: 0o700 });
  if (existsSync(SANDBOX_LOCK)) {
    try {
      const existing = JSON.parse(readFileSync(SANDBOX_LOCK, "utf-8")) as LockHolder;
      if (isPidAlive(existing.pid)) return { acquired: false, holder: existing };
    } catch { /* corrupt lock — reclaim */ }
  }
  writeFileSync(SANDBOX_LOCK, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
  return { acquired: true };
}

export function releaseGlobalSelfEditLock(): void {
  try { if (existsSync(SANDBOX_LOCK)) unlinkSync(SANDBOX_LOCK); } catch { /* best-effort */ }
}
