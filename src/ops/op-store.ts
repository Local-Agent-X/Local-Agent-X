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

export function writeOp(op: Op): void {
  const target = join(opDir(op.id), "operation.json");
  const tmp = target + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(op, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, target);
  } catch (e) {
    logger.warn(`[op-store] failed to write op ${op.id}: ${(e as Error).message}`);
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
  const op = readOp(opId);
  if (!op) return null;
  const updated: Op = { ...op, ...extras, status };
  if (status === "running" && !updated.startedAt) updated.startedAt = new Date().toISOString();
  if ((status === "completed" || status === "failed" || status === "cancelled") && !updated.completedAt) {
    updated.completedAt = new Date().toISOString();
  }
  writeOp(updated);
  return updated;
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
