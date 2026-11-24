/**
 * Per-repo autopilot lock at ~/.lax/autopilot/<repo-hash>.lock.
 *
 * Two repos can run autopilot simultaneously. A single repo gets exactly one
 * autopilot at a time — if the lock is held by a live PID, second start fails.
 * Stale locks (PID no longer alive) are reclaimed automatically.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import type { AutopilotLockFile } from "./types.js";
import { currentProcessIncarnation, processAlive } from "../persistence/process-incarnation.js";

import { createLogger } from "../logger.js";
const logger = createLogger("autopilot.lock");

const lockDir = (): string => join(getLaxDir(), "autopilot");

function getRepoHash(): string {
  try {
    const root = execSync("git rev-parse --show-toplevel", { encoding: "utf-8", timeout: 5_000, windowsHide: true }).trim();
    return createHash("sha1").update(root).digest("hex").slice(0, 12);
  } catch {
    // Fallback: hash cwd if not in a git repo.
    return createHash("sha1").update(process.cwd()).digest("hex").slice(0, 12);
  }
}

function getLockPath(): string {
  return join(lockDir(), `${getRepoHash()}.lock`);
}

/** The live holder of the lock at `lockPath`, or null when there is none
 *  (gone, a dead pid, a reused pid, or a file that cannot be read). */
function liveHolder(lockPath: string): AutopilotLockFile | null {
  try {
    const existing: AutopilotLockFile = JSON.parse(readFileSync(lockPath, "utf-8"));
    if (processAlive(existing.pid, existing.incarnation)) return existing;
    logger.info(`[autopilot.lock] Reclaiming stale lock from PID ${existing.pid}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") logger.warn(`[autopilot.lock] Corrupt lock file, reclaiming: ${(e as Error).message}`);
  }
  return null;
}

/** Try to acquire the lock. Returns null on success, or the holder info if
 *  blocked. The file is created exclusively, so two starts that both found it
 *  stale cannot both take it. */
export function acquireLock(opId: string, topic: string): AutopilotLockFile | null {
  if (!existsSync(lockDir())) mkdirSync(lockDir(), { recursive: true, mode: 0o700 });
  const lockPath = getLockPath();
  const lock: AutopilotLockFile = {
    pid: process.pid,
    incarnation: currentProcessIncarnation(),
    opId,
    topic,
    startedAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, JSON.stringify(lock, null, 2), { encoding: "utf-8", mode: 0o600, flag: "wx" });
      logger.info(`[autopilot.lock] Acquired (pid=${process.pid}, op=${opId})`);
      return null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const holder = liveHolder(lockPath);
    if (holder) {
      logger.info(`[autopilot.lock] Blocked by live PID ${holder.pid} (op ${holder.opId})`);
      return holder;
    }
    try { unlinkSync(lockPath); } catch { /* another start reclaimed it first; the next create decides */ }
  }
  // Lost to another start twice over: blocked by whoever holds it now.
  return readLock() ?? lock;
}

/** Release the lock. Safe to call multiple times. */
export function releaseLock(opId: string): void {
  const lockPath = getLockPath();
  if (!existsSync(lockPath)) return;
  try {
    const existing: AutopilotLockFile = JSON.parse(readFileSync(lockPath, "utf-8"));
    if (existing.pid !== process.pid || existing.opId !== opId) {
      logger.warn(`[autopilot.lock] Not releasing — held by another (pid=${existing.pid}, op=${existing.opId})`);
      return;
    }
    unlinkSync(lockPath);
    logger.info(`[autopilot.lock] Released (op=${opId})`);
  } catch (e) {
    logger.warn(`[autopilot.lock] Release failed: ${(e as Error).message}`);
  }
}

/** Inspect current lock holder without acquiring. */
export function readLock(): AutopilotLockFile | null {
  const lockPath = getLockPath();
  if (!existsSync(lockPath)) return null;
  try {
    return JSON.parse(readFileSync(lockPath, "utf-8"));
  } catch {
    return null;
  }
}

// Best-effort cleanup on process exit.
//
// SV-2 invariant: do NOT register SIGINT/SIGTERM handlers that process.exit()
// here. This runs at op start — AFTER the canonical graceful shutdown
// (server/lifecycle.ts registerShutdown) was wired at boot — and Node fires
// signal listeners synchronously in registration order, so a synchronous exit
// here would kill the process the moment the graceful handler suspends at its
// first `await`, skipping the memory push / browser close / worktree cleanup.
// releaseLock is synchronous, so the signal-agnostic 'exit' event (which the
// graceful handler's process.exit(0) fires) is sufficient; on an untrappable
// hard kill the lock self-heals anyway — acquireLock reclaims any lock whose
// pid is no longer alive.
let registeredExitHandler = false;
export function registerExitCleanup(opId: string): void {
  if (registeredExitHandler) return;
  registeredExitHandler = true;
  process.on("exit", () => releaseLock(opId));
}
