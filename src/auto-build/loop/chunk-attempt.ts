/**
 * One chunk's attempts: build it, have it reviewed (gates, the real build, the
 * chunk judge), and on a push_back fix it round by round through the advisor
 * (handle-push-back.ts) until it is green, a round changes nothing, or the
 * rounds run out, which is a halt for this chunk. The one way every path
 * builds a chunk: the serial loop (run.ts), a worktree build (parallel-chunk-
 * build.ts) and the worktree-cap fallback on base (parallel-waves.ts).
 */

import type { ParsedChunk } from "../plan-parser.js";
import type { ChunkReviewOutcome, ReviewAction } from "../chunk-review/index.js";
import { runChunkOnce } from "./run-chunk-once.js";
import { handlePushBack } from "./handle-push-back.js";
import type { EmitFn, LoopOptions, LoopResult } from "./types.js";

export interface ChunkAttemptInput {
  opts: LoopOptions;
  chunk: ParsedChunk;
  totalChunks: number;
  emit: EmitFn;
  /** HEAD of the tree the chunk builds in, before it starts. */
  preSha: string;
  /** Chunks already landed: their learnings go into the first brief. */
  priorOutcomes: LoopResult["outcomes"];
  /** The tree to build in when it is not the project itself (a worktree). */
  workTree?: string;
  /** Concurrent-build slot (parallel path): a distinct dev-server port. */
  workerIndex?: number;
  /** A chunk an earlier run set aside (carry-over.ts): the opening of its
   *  first brief, and the findings every fix round must keep fixed. */
  carryOver?: { brief: string; findings: string[] };
}

export interface ChunkAttemptResult {
  finalOutcome: ChunkReviewOutcome;
  finalAction: ReviewAction;
}

export async function buildChunkWithRetry(a: ChunkAttemptInput): Promise<ChunkAttemptResult> {
  const { opts, chunk, totalChunks, emit, preSha } = a;
  const shared = {
    chunk, totalChunks, emit, preSha,
    planPath: opts.planPath, plan: opts.plan,
    projectDir: a.workTree ?? opts.projectDir,
    subprocessTimeoutMs: opts.subprocessTimeoutMs, signal: opts.signal,
    judgmentHook: opts.judgmentHook, parentOpId: opts.parentOpId, parentSessionId: opts.parentSessionId,
    // The judge finds the sealed suite by the project's name, never a worktree's.
    chunkJudge: opts.chunkJudge, baseProjectDir: opts.projectDir, workerIndex: a.workerIndex,
  };

  const outcome = await runChunkOnce({
    ...shared,
    retryReason: a.carryOver?.brief,
    priorOutcomes: a.priorOutcomes,
  });
  if (outcome.action !== "push_back") return { finalOutcome: outcome, finalAction: outcome.action };
  return handlePushBack({ ...shared, outcome, earlierFindings: a.carryOver?.findings });
}
