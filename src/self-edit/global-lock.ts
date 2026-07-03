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
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { createLogger } from "../logger.js";

const logger = createLogger("self-edit.lock");
const SANDBOX_LOCK = join(getLaxDir(), "self-edit-sandbox.lock");

// TTL for locks held by ANOTHER live process (restart overlap, a second server).
// A worst-case run is ~28min: surgeon 10 (SURGEON_TIMEOUT_MS) + deps 5 + build 5
// + bind 2.5 + smoke + post-merge rebuild 5 — so the TTL must sit comfortably
// past that, or a second self_edit reclaims a lock whose holder is still mid-run
// and both build into the shared node_modules concurrently (the exact corruption
// this lock exists to stop). Locks held by THIS process are not TTL'd at all:
// the per-run nonce bookkeeping below knows exactly whether the run is still
// live (never reclaim) or was leaked by a crash-before-release (reclaim at once).
const STALE_AFTER_MS = 45 * 60_000;

export interface LockHolder {
  pid: number;
  startedAt: string;
  /** Per-run nonce written at acquire time. Ownership checks match on this, not
   *  just the pid: self_edit runs in-process, so a reclaimed lock's new holder
   *  has the SAME pid as the run it displaced — only the nonce tells them apart. */
  nonce?: string;
  /** The task the holder is running — lets a colliding caller tell a true
   *  duplicate (same change, fired by a second agent) from a different edit. */
  task?: string;
}

/** Nonce of the lock this process currently holds — set on successful acquire,
 *  cleared when we delete our own lock. Authoritative in-process bookkeeping:
 *  a same-pid lock file whose nonce we are tracking belongs to a genuinely live
 *  run; one we are NOT tracking was leaked (crash between acquire and the
 *  finally-release) and is immediately reclaimable. */
let currentNonce: string | undefined;

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
  /** The task being run — recorded in the lock so a colliding caller can report
   *  whether it's the same change or a different one. */
  task?: string;
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** A lock is reclaimable if its holder is provably not a live run:
 *  - dead holder pid → reclaim;
 *  - OUR pid → the in-process nonce bookkeeping decides. Tracked nonce = the run
 *    is genuinely still going, NEVER reclaim (a worst-case run outlives any TTL,
 *    and reclaiming it puts two self_edits in the shared node_modules at once);
 *    untracked = leaked by a crash-before-release, reclaim immediately;
 *  - another LIVE pid → we can't introspect it, so fall back to the age TTL. */
function isReclaimable(holder: LockHolder): boolean {
  if (!isPidAlive(holder.pid)) return true;
  if (holder.pid === process.pid) {
    return currentNonce === undefined || holder.nonce !== currentNonce;
  }
  const ageMs = Date.now() - Date.parse(holder.startedAt);
  return Number.isFinite(ageMs) && ageMs > STALE_AFTER_MS;
}

function lockPayload(nonce: string, task?: string): string {
  return JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), nonce, task });
}

function readHolder(): LockHolder | undefined {
  try { return JSON.parse(readFileSync(SANDBOX_LOCK, "utf-8")) as LockHolder; } catch { return undefined; }
}

function normalizeTask(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80);
}

/**
 * A colliding caller's message. self_edit edits the shared source tree, so only
 * one can run at a time — a second dispatch (typically a second agent acting on
 * the same instruction) can NEVER proceed and must not retry-loop. Returns a
 * benign, non-"BLOCKED"-prefixed notice (so it doesn't read as a tool failure
 * or trip the circuit breaker) that tells the caller to end its turn.
 */
export function formatGlobalLockBusy(holder: LockHolder | undefined, incomingTask: string): string {
  const ageMs = holder ? Date.now() - Date.parse(holder.startedAt) : NaN;
  const ageS = Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : 0;
  const same = !!holder?.task && normalizeTask(holder.task) === normalizeTask(incomingTask);
  const what = same
    ? "the same change is already being applied"
    : "a self_edit is already applying a change";
  return (
    `A self_edit is already running on this machine (started ${ageS}s ago) — ${what}. ` +
    `self_edit edits the shared source tree, so only one runs at a time. ` +
    `END THIS TURN NOW — tell the user, in your own words, that the edit is in flight and you'll surface the result when it lands. ` +
    `Do NOT call self_edit again: every retry returns this same notice until the running one finishes.`
  );
}

/** Atomically create the lock file (fails if it already exists). Returns false
 *  on EEXIST, true on success; rethrows anything else. The `wx` flag is the
 *  OS-level exclusive create that closes the check-then-write race. */
function tryCreateLock(task?: string): boolean {
  const nonce = randomUUID();
  try {
    writeFileSync(SANDBOX_LOCK, lockPayload(nonce, task), { mode: 0o600, flag: "wx" });
    currentNonce = nonce;
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

/**
 * Acquire the global self_edit lock. Atomic create-exclusive, so two processes
 * can't both win. A stale lock — dead holder PID, corrupt file, OR held past the
 * STALE_AFTER_MS TTL — is reclaimed. A live, in-window holder blocks
 * (acquired=false, holder reported) unless opts.force, in which case the live
 * lock is stolen (emergency `_unsafe` rescue only).
 */
export function acquireGlobalSelfEditLock(opts: AcquireOptions = {}): LockResult {
  mkdirSync(getLaxDir(), { recursive: true, mode: 0o700 });
  if (tryCreateLock(opts.task)) return { acquired: true };

  // Lock exists — inspect the holder.
  const holder = readHolder();
  const blocking = !!holder && !isReclaimable(holder);
  if (blocking && !opts.force) return { acquired: false, holder };

  if (blocking && opts.force) {
    logger.warn(`[self-edit.lock] force-overriding live global self_edit lock (pid=${holder?.pid}, started=${holder?.startedAt}) — emergency _unsafe rescue`);
  } else if (holder) {
    const reason = !isPidAlive(holder.pid) ? "dead holder pid" : "held past TTL";
    logger.warn(`[self-edit.lock] reclaiming stale global self_edit lock (${reason}, pid=${holder.pid}, started=${holder.startedAt})`);
  }
  // Stale / corrupt / force-stolen — reclaim by removing then re-creating.
  try { unlinkSync(SANDBOX_LOCK); } catch { /* raced */ }
  if (tryCreateLock(opts.task)) return { acquired: true };

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
  return !!holder && !isReclaimable(holder);
}

/** Release the lock, but ONLY if we still own it — matched by the per-run nonce,
 *  not just the pid. self_edit runs in-process, so a lock reclaimed or
 *  force-stolen by a later run in THIS server carries the SAME pid as the run it
 *  displaced; a pid-only check would let the displaced run's finally-release
 *  delete the new owner's lock out from under it. */
export function releaseGlobalSelfEditLock(): void {
  try {
    if (!existsSync(SANDBOX_LOCK)) return;
    const holder = readHolder();
    if (!currentNonce || !holder || holder.pid !== process.pid || holder.nonce !== currentNonce) {
      return; // not ours anymore
    }
    currentNonce = undefined;
    unlinkSync(SANDBOX_LOCK);
  } catch { /* best-effort */ }
}
