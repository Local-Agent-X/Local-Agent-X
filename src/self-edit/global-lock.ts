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
import { createLogger } from "../logger.js";

const logger = createLogger("self-edit.lock");
const SANDBOX_LOCK = join(getLaxDir(), "self-edit-sandbox.lock");

export interface LockHolder {
  pid: number;
  startedAt: string;
}

export interface LockResult {
  acquired: boolean;
  holder?: LockHolder;
}

export interface AcquireOptions {
  /** Emergency override: if the lock is held by a LIVE process, steal it anyway
   *  (logging the displaced holder). Used only by the `_unsafe` rescue hatch —
   *  a human explicitly fixing a bricked app must not be blocked indefinitely by
   *  another self_edit. Automated paths (sandbox, autopilot `_cwd`) never force. */
  force?: boolean;
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function lockPayload(): string {
  return JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
}

function readHolder(): LockHolder | undefined {
  try { return JSON.parse(readFileSync(SANDBOX_LOCK, "utf-8")) as LockHolder; } catch { return undefined; }
}

/** Atomically create the lock file (fails if it already exists). Returns false
 *  on EEXIST, true on success; rethrows anything else. The `wx` flag is the
 *  OS-level exclusive create that closes the check-then-write race. */
function tryCreateLock(): boolean {
  try {
    writeFileSync(SANDBOX_LOCK, lockPayload(), { mode: 0o600, flag: "wx" });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

/**
 * Acquire the global self_edit lock. Atomic create-exclusive, so two processes
 * can't both win. A stale lock (dead holder PID) or corrupt file is reclaimed.
 * A live holder blocks (acquired=false, holder reported) — unless opts.force,
 * in which case the live lock is stolen (emergency `_unsafe` rescue only).
 */
export function acquireGlobalSelfEditLock(opts: AcquireOptions = {}): LockResult {
  mkdirSync(getLaxDir(), { recursive: true, mode: 0o700 });
  if (tryCreateLock()) return { acquired: true };

  // Lock exists — inspect the holder.
  const holder = readHolder();
  const live = !!holder && isPidAlive(holder.pid);
  if (live && !opts.force) return { acquired: false, holder };

  if (live && opts.force) {
    logger.warn(`[self-edit.lock] force-overriding live global self_edit lock (pid=${holder?.pid}, started=${holder?.startedAt}) — emergency _unsafe rescue`);
  }
  // Stale / corrupt / force-stolen — reclaim by removing then re-creating.
  try { unlinkSync(SANDBOX_LOCK); } catch { /* raced */ }
  if (tryCreateLock()) return { acquired: true };

  // Lost the reclaim race to another process that recreated the lock first.
  return { acquired: false, holder: readHolder() };
}

/** True if the global self_edit lock is currently held by a LIVE process. The
 *  boot-time orphan-worktree sweep checks this: a live holder means a self_edit
 *  (in this or, during a restart overlap, another process) owns a worktree under
 *  %TEMP%/lax-worktrees, so the sweep must not treat it as an orphan and unlink
 *  the node_modules junction it's actively building on. A stale (dead-pid) lock
 *  returns false — that worktree really is an orphan. */
export function isSelfEditLockHeldByLiveProcess(): boolean {
  const holder = readHolder();
  return !!holder && isPidAlive(holder.pid);
}

/** Release the lock, but ONLY if we still own it. If we were force-displaced by
 *  an `_unsafe` rescue, the file now belongs to that process — deleting it would
 *  free the lock out from under the live owner. */
export function releaseGlobalSelfEditLock(): void {
  try {
    if (!existsSync(SANDBOX_LOCK)) return;
    const holder = readHolder();
    if (holder && holder.pid !== process.pid) return; // not ours anymore
    unlinkSync(SANDBOX_LOCK);
  } catch { /* best-effort */ }
}
