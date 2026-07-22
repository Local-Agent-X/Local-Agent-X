/**
 * Per-op metadata persistence.
 *
 * operation.json holds the Op's stable identity and lifecycle state. The
 * supervisor's source of truth for "what ops exist and what's their
 * status." Updated atomically (tmp + rename) on every status change.
 *
 * Writes happen on the supervisor side; the worker only reads the Op as
 * part of the IPC assign-op payload. So this module only needs to be
 * importable from the parent process.
 */

import {
  existsSync,
  writeFileSync,
  readFileSync,
  renameSync,
  readdirSync,
  rmSync,
  statSync,
  mkdirSync,
  rmdirSync,
} from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { opDir } from "./event-log.js";
import type { Op, OpStatus } from "./types.js";
import { randomId } from "../util/ids.js";

import { createLogger } from "../logger.js";
const logger = createLogger("workers.op-store");

const OPS_BASE = join(getLaxDir(), "operations");

/**
 * Interactive HOST-turn op types: the op executing the current tool-calling
 * turn (a chat turn or a voice turn). The per-session "is a peer op already
 * running?" (op_submit_async) and "most recent live op" (op_kill) guards MUST
 * exclude these — otherwise a tool called from inside the host turn counts its
 * own parent as a blocking/target peer. chat_turn was excluded but voice_turn
 * was missed, so op_submit_async self-blocked in voice: it never spawned a
 * worker and the model read the BLOCKED text aloud as "already running."
 */
export function isInteractiveHostOpType(type: string): boolean {
  return type === "chat_turn" || type === "voice_turn";
}

type StrictWriteFailurePoint = "before_write" | "before_rename";
let strictWriteFailureForTest: {
  error: NodeJS.ErrnoException;
  point: StrictWriteFailurePoint;
  attempt: number;
  seen: number;
} | null = null;

export function _setStrictOpWriteFailureForTest(
  error: NodeJS.ErrnoException | null,
  point: StrictWriteFailurePoint = "before_write",
  attempt = 1,
): void {
  strictWriteFailureForTest = error ? { error, point, attempt, seen: 0 } : null;
}

export function writeOp(op: Op): void {
  const error = attemptWriteOp(op, false);
  if (error) logger.warn(`[op-store] failed to write op ${op.id}: ${error.message}`);
}

/** Strict lease/recovery persistence. Unlike writeOp, failure is observable. */
export function writeOpStrict(op: Op): boolean {
  const error = attemptWriteOp(op, true);
  if (error) logger.warn(`[op-store] strict write failed for ${op.id}: ${error.message}`);
  return error === null;
}

function attemptWriteOp(op: Op, strict: boolean): Error | null {
  const target = join(opDir(op.id), "operation.json");
  // Unique tmp per write: a fixed `.tmp` name is shared by every writer, so
  // two processes on one ~/.lax can interleave (one renames the other's
  // half-written or wrong-content file). rename() itself stays atomic.
  const tmp = `${target}.${randomId()}.tmp`;
  try {
    const failure = strict ? strictWriteFailureForTest : null;
    const failureAttempt = failure ? ++failure.seen : 0;
    if (failure && failureAttempt === failure.attempt && failure.point === "before_write") {
      throw failure.error;
    }
    writeFileSync(tmp, JSON.stringify(op, null, 2), { encoding: "utf-8", mode: 0o600 });
    if (failure && failureAttempt === failure.attempt && failure.point === "before_rename") {
      throw failure.error;
    }
    renameSync(tmp, target);
    return null;
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* best-effort tmp cleanup */ }
    return e as Error;
  }
}

const LOCK_STALE_MS = 2_000;
const LOCK_WAIT_MS = 500;
const LOCK_RETRY_MS = 10;
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
/** In-process reentrancy guard: opIds whose lock this call stack already holds. */
const heldLocks = new Map<string, string>();

export type OpLockResult<T> =
  | { acquired: true; value: T }
  | { acquired: false };

function sleepSync(ms: number): void {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

/**
 * Serialize a read→modify→write sequence on an op's operation.json across
 * processes (two servers sharing one ~/.lax). The lock is an exclusive
 * directory with a unique owner token; stale crashed claims are reclaimed
 * after LOCK_STALE_MS. Contention never executes the mutation unlocked.
 */
export function tryWithOpLock<T>(opId: string, fn: () => T): OpLockResult<T> {
  if (heldLocks.has(opId)) return { acquired: true, value: fn() };
  const lockPath = join(opDir(opId), "operation.lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  const token = randomId("lock");
  for (;;) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      writeFileSync(join(lockPath, token), JSON.stringify({ token, pid: process.pid }), {
        encoding: "utf-8",
        mode: 0o600,
        flag: "wx",
      });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        logger.warn(`[op-store] cannot create lock for ${opId}: ${(e as Error).message}`);
        cleanupOwnedLock(lockPath, token);
        return { acquired: false };
      }
      if (reclaimStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        logger.warn(`[op-store] lock timeout for ${opId}; mutation skipped`);
        return { acquired: false };
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  heldLocks.set(opId, token);
  try {
    return { acquired: true, value: fn() };
  } finally {
    heldLocks.delete(opId);
    cleanupOwnedLock(lockPath, token);
  }
}

/** Legacy general persistence callers retain their fail-open behavior. Lease
 * ownership uses tryWithOpLock directly and never enters this fallback. */
export function withOpLock<T>(opId: string, fn: () => T): T {
  const result = tryWithOpLock(opId, fn);
  if (result.acquired) return result.value;
  logger.warn(`[op-store] lock timeout for ${opId}; proceeding unlocked`);
  return fn();
}

function cleanupOwnedLock(lockPath: string, token: string): void {
  try { rmSync(join(lockPath, token), { force: true }); } catch { /* no longer ours */ }
  try { rmdirSync(lockPath); } catch { /* replacement or malformed claim remains */ }
}

function reclaimStaleLock(lockPath: string): boolean {
  let stat;
  try { stat = statSync(lockPath); } catch { return true; }
  if (Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return false;

  if (!stat.isDirectory()) {
    try { rmSync(lockPath, { force: true }); return true; } catch { return false; }
  }
  let observed: string[];
  try { observed = readdirSync(lockPath); } catch { return true; }
  for (const entry of observed) {
    try {
      const owner = JSON.parse(readFileSync(join(lockPath, entry), "utf-8")) as { pid?: unknown };
      if (typeof owner.pid === "number" && isProcessAlive(owner.pid)) return false;
    } catch { /* malformed stale token is reclaimable */ }
  }
  for (const entry of observed) {
    try { rmSync(join(lockPath, entry), { recursive: true, force: true }); } catch { return false; }
  }
  try { rmdirSync(lockPath); return true; } catch { return false; }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export function readOp(opId: string): Op | null {
  const path = join(opDir(opId), "operation.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    logger.warn(`[op-store] failed to read op ${opId}: ${(e as Error).message}`);
    return null;
  }
}

export function listOps(): Op[] {
  if (!existsSync(OPS_BASE)) return [];
  const dirs = readdirSync(OPS_BASE);
  const out: Op[] = [];
  for (const d of dirs) {
    const op = readOp(d);
    if (op) out.push(op);
  }
  // Newest first. Coerce because at least one writer persists createdAt as a
  // number (autopilot op_ap_*); .localeCompare on a number throws.
  return out.sort((a, b) => String(b.startedAt || b.createdAt).localeCompare(String(a.startedAt || a.createdAt)));
}

/** Bounded persistence query for callers that need only recently mutated ops.
 * It orders by operation.json metadata before decoding any persisted payload. */
export function listRecentOps(limit: number): Op[] {
  if (!existsSync(OPS_BASE) || !Number.isSafeInteger(limit) || limit <= 0) return [];
  const candidates: Array<{ id: string; mtimeMs: number }> = [];
  for (const id of readdirSync(OPS_BASE)) {
    try {
      const stat = statSync(join(OPS_BASE, id, "operation.json"));
      if (stat.isFile()) candidates.push({ id, mtimeMs: stat.mtimeMs });
    } catch { /* concurrently removed or incomplete op */ }
  }
  return candidates
    .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limit)
    .map(({ id }) => readOp(id))
    .filter((op): op is Op => op !== null);
}

/** Convenience: update just the status field + a few common transition fields. */
export function setOpStatus(opId: string, status: OpStatus, extras: Partial<Op> = {}): Op | null {
  return withOpLock(opId, () => {
    const op = readOp(opId);
    if (!op) return null;
    const updated: Op = { ...op, ...extras, status };
    if (status === "running" && !updated.startedAt) updated.startedAt = new Date().toISOString();
    if ((status === "completed" || status === "failed" || status === "cancelled") && !updated.completedAt) {
      updated.completedAt = new Date().toISOString();
    }
    writeOp(updated);
    return updated;
  });
}

/**
 * Restrict an op-id prefix to a filesystem-safe charset before it becomes a
 * path segment under the operations root. The prefix is seeded by the op
 * "type", which is model-controlled at the op_submit_async seam
 * (ops/tools/shared.ts) — so path metacharacters (`..`, `/`, `\`, drive
 * colons, NULs) must never survive into opDir()'s join(). Disallowed runs
 * collapse to a single `_`; an all-unsafe prefix falls back to `op`.
 */
export function sanitizeIdPrefix(prefix: string, fallback = "op"): string {
  const safe = prefix.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe || fallback;
}

export function newOpId(prefix = "op"): string {
  return randomId(sanitizeIdPrefix(prefix));
}

const TERMINAL_STATUSES: OpStatus[] = ["completed", "failed", "cancelled"];

export interface PruneResult {
  pruned: number;
  kept: number;
  errors: number;
}

export function pruneOldOps(maxAgeMs: number): PruneResult {
  const result: PruneResult = { pruned: 0, kept: 0, errors: 0 };
  if (!existsSync(OPS_BASE)) return result;
  const cutoff = Date.now() - maxAgeMs;
  let dirs: string[];
  try { dirs = readdirSync(OPS_BASE); } catch (e) {
    logger.warn(`[op-store] prune: cannot read ${OPS_BASE}: ${(e as Error).message}`);
    return result;
  }
  for (const id of dirs) {
    const dir = join(OPS_BASE, id);
    const op = readOp(id);
    if (!op) {
      // No operation.json — fall back to dir mtime so stray dirs still age out.
      try {
        const mtime = statSync(dir).mtimeMs;
        if (mtime < cutoff) {
          rmSync(dir, { recursive: true, force: true });
          result.pruned++;
        } else {
          result.kept++;
        }
      } catch {
        result.errors++;
      }
      continue;
    }
    if (!TERMINAL_STATUSES.includes(op.status)) {
      result.kept++;
      continue;
    }
    const ts = op.completedAt || op.startedAt || op.createdAt;
    const age = ts ? Date.parse(ts) : NaN;
    if (!Number.isFinite(age) || age >= cutoff) {
      result.kept++;
      continue;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
      result.pruned++;
    } catch (e) {
      logger.warn(`[op-store] prune: failed to delete ${id}: ${(e as Error).message}`);
      result.errors++;
    }
  }
  return result;
}
