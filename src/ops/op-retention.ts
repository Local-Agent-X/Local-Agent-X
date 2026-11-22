/**
 * How long the record of a finished upkeep run is kept.
 *
 * Nothing deleted an op once the worker pool went (its boot prune was the only
 * caller), so the store only grew: 5,198 ops and 2.1 GB on the owner's machine
 * (2026-11-22). A quarter of that was the app's own upkeep: memory passes,
 * skill and failure reviews, mail and travel watches. Nobody asked for those
 * runs and what they produce is kept elsewhere (memory, skills, lessons, the
 * inbox), so their records go a week after they finish.
 *
 * Every other op stays: a chat or voice turn, an agent, a build, a scheduled
 * job, a review of the user's work. Those are the record the agent goes back
 * to (owner's call, 2026-11-22).
 *
 * Which ops to delete comes from the op index, so a pass reads no record.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { opIdsWhere } from "./op-index.js";
import { OPS_BASE } from "./op-store.js";
import { UPKEEP_OP_TYPES } from "./op-types.js";

const logger = createLogger("ops.retention");

export const UPKEEP_OP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface UpkeepPruneResult {
  pruned: number;
  failed: number;
}

/** Delete the upkeep ops that finished more than `maxAgeMs` ago. An op still
 *  in flight, or one whose dates cannot be read, is never deleted. */
export async function pruneFinishedUpkeepOps(
  now: number = Date.now(),
  maxAgeMs: number = UPKEEP_OP_RETENTION_MS,
): Promise<UpkeepPruneResult> {
  const cutoff = now - maxAgeMs;
  const ids = opIdsWhere((facts) =>
    !facts.open && UPKEEP_OP_TYPES.has(facts.type) && facts.endedAt !== undefined && facts.endedAt < cutoff);
  const result: UpkeepPruneResult = { pruned: 0, failed: 0 };
  for (const id of ids) {
    try {
      // The promise rm: it retries a file Windows still holds, and it does
      // not block the server's thread while a large folder goes.
      await rm(join(OPS_BASE, id), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      result.pruned++;
    } catch (e) {
      result.failed++;
      logger.warn(`[op-retention] could not delete ${id}: ${(e as Error).message}`);
    }
  }
  return result;
}
