/**
 * Per-op checkpoint writer.
 *
 * Per spec §3: events.jsonl is what HAPPENED; checkpoint.json is what's
 * needed to RESUME. The supervisor reads checkpoint.json (not events) when
 * reassigning a recovered op to a new worker.
 *
 * Workers write checkpoints at safe boundaries:
 *   - after a committing tool call (write/edit/bash POST/etc.)
 *   - after every N model turns (currently 3)
 *   - NEVER inside a model call (would capture incomplete state)
 *
 * The checkpoint is overwritten in place — the events log carries the
 * history; the checkpoint just carries the latest resumable state.
 */

import { existsSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { opDir } from "./event-log.js";
import type { OpCheckpoint } from "./types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("workers.checkpoint");

/** Atomic write: tmp file then rename. Prevents torn-write recovery from
 *  a checkpoint that's half-on-disk when the worker died mid-write. */
export function writeCheckpoint(checkpoint: OpCheckpoint): void {
  const dir = opDir(checkpoint.opId);
  const target = join(dir, "checkpoint.json");
  const tmp = target + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(checkpoint, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, target);
  } catch (e) {
    logger.warn(`[checkpoint] failed to write for ${checkpoint.opId}: ${(e as Error).message}`);
  }
}

/** Read latest checkpoint for an op. Returns null if none yet. */
export function readCheckpoint(opId: string): OpCheckpoint | null {
  const path = join(opDir(opId), "checkpoint.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    logger.warn(`[checkpoint] failed to read for ${opId}: ${(e as Error).message}`);
    return null;
  }
}

/** Helper to construct a fresh checkpoint at op start. */
export function newCheckpoint(opId: string, providerUsed: string): OpCheckpoint {
  return {
    opId,
    updatedAt: new Date().toISOString(),
    plan: [],
    completedSteps: 0,
    worktreeBranch: null,
    lastCommitSha: null,
    changedFiles: [],
    pendingInstructions: [],
    providerUsed,
    retryCount: 0,
    lastSafeBoundary: { label: "op-started", timestamp: new Date().toISOString() },
  };
}
