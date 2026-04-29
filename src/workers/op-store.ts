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

import { existsSync, writeFileSync, readFileSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { opDir } from "./event-log.js";
import type { Op, OpStatus } from "./types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("workers.op-store");

const OPS_BASE = join(homedir(), ".lax", "operations");

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
  // Newest first
  return out.sort((a, b) => (b.startedAt || b.createdAt).localeCompare(a.startedAt || a.createdAt));
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
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
