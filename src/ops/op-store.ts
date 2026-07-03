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

import { existsSync, writeFileSync, readFileSync, renameSync, readdirSync, rmSync, statSync } from "node:fs";
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

export function writeOp(op: Op): void {
  const target = join(opDir(op.id), "operation.json");
  // Unique tmp per write: a fixed `.tmp` name is shared by every writer, so
  // two processes on one ~/.lax can interleave (one renames the other's
  // half-written or wrong-content file). rename() itself stays atomic.
  const tmp = `${target}.${randomId()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(op, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, target);
  } catch (e) {
    logger.warn(`[op-store] failed to write op ${op.id}: ${(e as Error).message}`);
    try { rmSync(tmp, { force: true }); } catch { /* best-effort tmp cleanup */ }
  }
}

const LOCK_STALE_MS = 2_000;
const LOCK_WAIT_MS = 500;
const LOCK_RETRY_MS = 10;
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
/** In-process reentrancy guard: opIds whose lock this call stack already holds. */
const heldLocks = new Set<string>();

function sleepSync(ms: number): void {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

/**
 * Serialize a read→modify→write sequence on an op's operation.json across
 * processes (two servers sharing one ~/.lax). The lock is an O_EXCL lockfile
 * in the op dir; a stale lock (crashed holder) is stolen after LOCK_STALE_MS.
 * Fail-open: if the lock cannot be acquired within LOCK_WAIT_MS, `fn` runs
 * anyway with a warning — a leaked lock must never brick op persistence.
 */
export function withOpLock<T>(opId: string, fn: () => T): T {
  if (heldLocks.has(opId)) return fn(); // reentrant within the same sync call stack
  const lockPath = join(opDir(opId), "operation.lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  for (;;) {
    try {
      writeFileSync(lockPath, String(process.pid), { encoding: "utf-8", mode: 0o600, flag: "wx" });
      held = true;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        logger.warn(`[op-store] cannot create lock for ${opId}: ${(e as Error).message}`);
        break;
      }
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { force: true }); // crashed holder — steal
          continue;
        }
      } catch { continue; } // holder released between attempts — retry now
      if (Date.now() >= deadline) {
        logger.warn(`[op-store] lock timeout for ${opId}; proceeding unlocked`);
        break;
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  if (held) heldLocks.add(opId);
  try {
    return fn();
  } finally {
    if (held) {
      heldLocks.delete(opId);
      try { rmSync(lockPath, { force: true }); } catch { /* already gone */ }
    }
  }
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

export function newOpId(prefix = "op"): string {
  return randomId(prefix);
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
