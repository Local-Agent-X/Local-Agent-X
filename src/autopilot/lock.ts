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

import { createLogger } from "../logger.js";
const logger = createLogger("autopilot.lock");

const LOCK_DIR = join(getLaxDir(), "autopilot");

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
  return join(LOCK_DIR, `${getRepoHash()}.lock`);
}

function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 just checks for existence without sending a signal.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Try to acquire the lock. Returns null on success, or the holder info if blocked. */
export function acquireLock(opId: string, topic: string): AutopilotLockFile | null {
  if (!existsSync(LOCK_DIR)) mkdirSync(LOCK_DIR, { recursive: true, mode: 0o700 });
  const lockPath = getLockPath();

  if (existsSync(lockPath)) {
    try {
      const existing: AutopilotLockFile = JSON.parse(readFileSync(lockPath, "utf-8"));
      if (isPidAlive(existing.pid)) {
        logger.info(`[autopilot.lock] Blocked by live PID ${existing.pid} (op ${existing.opId})`);
        return existing;
      }
      logger.info(`[autopilot.lock] Reclaiming stale lock from PID ${existing.pid}`);
    } catch (e) {
      logger.warn(`[autopilot.lock] Corrupt lock file, reclaiming: ${(e as Error).message}`);
    }
  }

  const lock: AutopilotLockFile = {
    pid: process.pid,
    opId,
    topic,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(lockPath, JSON.stringify(lock, null, 2), { encoding: "utf-8", mode: 0o600 });
  logger.info(`[autopilot.lock] Acquired (pid=${process.pid}, op=${opId})`);
  return null;
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
let registeredExitHandler = false;
export function registerExitCleanup(opId: string): void {
  if (registeredExitHandler) return;
  registeredExitHandler = true;
  const cleanup = () => releaseLock(opId);
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });
}
