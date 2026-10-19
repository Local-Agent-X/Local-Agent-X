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
import { atomicWriteFileSync, type AtomicWriteOperations } from "../util/json-store.js";

import { createLogger } from "../logger.js";
import { OP_TYPE } from "./op-types.js";
const logger = createLogger("workers.op-store");

const OPS_BASE = join(getLaxDir(), "operations");

/** What this module writes to operation.json, and the one shape it reads back. */
export const OP_RECORD_KIND = "op";
export const OP_SCHEMA_VERSION = 1;

/**
 * The Op in a parsed operation.json, or null when the file holds another
 * record: autopilot's Operation (kind "autopilot", or — before kinds were
 * stamped — a record with a `goal` and no `task`), or an Op written by a
 * newer build. ~55 callers used to cast the parse blindly, so an autopilot
 * record came back as an Op with no `task`.
 */
export function parseOp(raw: unknown, opId: string): Op | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (record.kind !== undefined && record.kind !== OP_RECORD_KIND) return null;
  if (typeof record.schemaVersion === "number" && record.schemaVersion > OP_SCHEMA_VERSION) {
    logger.warn(`[op-store] ${opId} is schema version ${record.schemaVersion}; this build reads ${OP_SCHEMA_VERSION} — skipped`);
    return null;
  }
  // The one field every reader of an Op dereferences, and the one an
  // autopilot record never carries. A minimal pre-kind Op (id, type, task,
  // lane, status) is still an Op.
  if (record.kind === undefined && typeof record.task !== "string") return null;
  return record as unknown as Op;
}

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
  return type === OP_TYPE.chatTurn || type === OP_TYPE.voiceTurn;
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

// Routed through the canonical atomic write rather than a local tmp+rename:
// on Windows a rename over a destination another process holds open fails with
// EPERM, and a bare renameSync has no answer to that. Measured on an idle
// Windows box: 0% of renames fail with no concurrent reader, 5-34% with one.
// A dropped write here silently loses an Op's lifecycle transition, so the
// bounded contention retry in atomicWriteFileSync is load-bearing, not polish.
function attemptWriteOp(op: Op, strict: boolean): Error | null {
  const target = join(opDir(op.id), "operation.json");
  const record: Op = { kind: OP_RECORD_KIND, schemaVersion: OP_SCHEMA_VERSION, ...op };
  try {
    atomicWriteFileSync(
      target,
      JSON.stringify(record, null, 2),
      { mode: 0o600 },
      injectedWriteFailure(strict),
    );
    return null;
  } catch (e) {
    return e as Error;
  }
}

/**
 * Test seam: fail one strict write at a chosen point. `seen` advances once per
 * strict write and never per rename retry, so `attempt: 2` still selects the
 * second write rather than the second attempt inside a single write.
 */
function injectedWriteFailure(strict: boolean): AtomicWriteOperations | undefined {
  const failure = strict ? strictWriteFailureForTest : null;
  if (!failure) return undefined;
  if (++failure.seen !== failure.attempt) return undefined;
  return {
    write: (path, data, opts) => {
      if (failure.point === "before_write") throw failure.error;
      writeFileSync(path, data, opts);
    },
    rename: (source, destination) => {
      if (failure.point === "before_rename") throw failure.error;
      renameSync(source, destination);
    },
    unlink: path => rmSync(path, { force: true }),
  };
}

const LOCK_STALE_MS = 2_000;
const LOCK_WAIT_MS = 500;
const LOCK_RETRY_MS = 10;
/** An empty lock directory holds no claim: its creator writes its token right
 *  after mkdir, so past this grace it is a release whose rmdir failed (Windows
 *  refuses one while a scanner or indexer has the folder open). Its mtime is
 *  the token's removal, so under LOCK_STALE_MS alone it would read as a fresh
 *  claim and skip every mutation for two seconds. */
const EMPTY_LOCK_GRACE_MS = 250;
/** How many times a release retries a removal Windows refused for a moment. */
const RELEASE_RETRIES = 20;
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
      // Another caller may have reclaimed this directory as empty before the
      // token landed and claimed it as its own: then both tokens are here, and
      // this one backs off rather than share the lock.
      if (soleClaim(lockPath, token)) break;
      cleanupOwnedLock(lockPath, token);
      if (Date.now() >= deadline) {
        logger.warn(`[op-store] lock timeout for ${opId}; mutation skipped`);
        return { acquired: false };
      }
      sleepSync(LOCK_RETRY_MS);
    } catch (e) {
      // The directory was reclaimed between mkdir and the token: try again.
      if ((e as NodeJS.ErrnoException).code === "ENOENT" && Date.now() < deadline) continue;
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

function soleClaim(lockPath: string, token: string): boolean {
  try {
    const entries = readdirSync(lockPath);
    return entries.length === 1 && entries[0] === token;
  } catch {
    return false;
  }
}

/** A removal Windows refuses for a moment (a scanner or indexer has it open). */
function transientRemoveError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

function retryRemoval(remove: () => void): void {
  for (let attempt = 0; ; attempt++) {
    try { remove(); return; } catch (e) {
      if (attempt >= RELEASE_RETRIES || !transientRemoveError(e)) return;
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

function cleanupOwnedLock(lockPath: string, token: string): void {
  // No longer ours, or a replacement / malformed claim remains (ENOTEMPTY):
  // both leave the directory alone.
  retryRemoval(() => rmSync(join(lockPath, token), { force: true }));
  retryRemoval(() => rmdirSync(lockPath));
}

function reclaimStaleLock(lockPath: string): boolean {
  let stat;
  try { stat = statSync(lockPath); } catch { return true; }
  const age = Date.now() - stat.mtimeMs;

  if (!stat.isDirectory()) {
    if (age <= LOCK_STALE_MS) return false;
    try { rmSync(lockPath, { force: true }); return true; } catch { return false; }
  }
  let observed: string[];
  try { observed = readdirSync(lockPath); } catch { return true; }
  if (observed.length === 0) {
    if (age <= EMPTY_LOCK_GRACE_MS) return false;
    try { rmdirSync(lockPath); return true; } catch { return false; }
  }
  if (age <= LOCK_STALE_MS) return false;
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
    return parseOp(JSON.parse(readFileSync(path, "utf-8")), opId);
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
