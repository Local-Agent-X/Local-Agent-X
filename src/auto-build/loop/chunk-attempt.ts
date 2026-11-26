/**
 * One chunk's attempts: build it, have it reviewed (gates, the real build, the
 * chunk judge), and on a push_back fix it round by round through the advisor
 * (handle-push-back.ts) until it is green, a round changes nothing, or the
 * rounds run out, which is a halt for this chunk. The one way every path
 * builds a chunk: the serial loop (run.ts), a worktree build (parallel-chunk-
 * build.ts) and the worktree-cap fallback on base (parallel-waves.ts).
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ParsedChunk } from "../plan-parser.js";
import type { ChunkReviewOutcome, ReviewAction } from "../chunk-review/index.js";
import { runChunkOnce } from "./run-chunk-once.js";
import { handlePushBack } from "./handle-push-back.js";
import { dropWorkerConversation, loadWorkerConversation, saveWorkerConversation } from "./worker-conversation.js";
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
  carryOver?: { brief: string; findings: string[]; round?: number };
  /** Each fix round as it starts (handle-push-back.ts). */
  onRound?: (round: number, findings: string[]) => void;
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
    buildLead: opts.buildLead,
  };

  // A fix round goes back to the worker that built the chunk
  // (handle-push-back.ts), so its conversation is kept, with or without a
  // lead, and on disk, so a Pause or a restart of LAX does not lose it
  // (worker-conversation.ts). A chunk paused mid-build goes on from it.
  const kept = (m: ChatCompletionMessageParam[]): void => { transcript = m; saveWorkerConversation(opts.projectDir, chunk.number, m); };
  let transcript: ChatCompletionMessageParam[] | undefined;
  const resumed = a.carryOver?.round != null ? loadWorkerConversation(opts.projectDir, chunk.number) : undefined;
  const outcome = await runChunkOnce({
    ...shared,
    retryReason: a.carryOver?.brief,
    priorOutcomes: a.priorOutcomes,
    ...(resumed ? { continueFrom: resumed, resumed: true } : {}),
    onTranscript: kept,
  });
  const result = outcome.action !== "push_back"
    ? { finalOutcome: outcome, finalAction: outcome.action }
    : await handlePushBack({
      ...shared, outcome, earlierFindings: a.carryOver?.findings, ...(transcript ? { lastTranscript: transcript } : {}),
      // A chunk paused in a round goes on from it: this first attempt redid that round.
      ...(a.carryOver?.round != null ? { firstRound: a.carryOver.round + 1 } : {}),
      ...(a.onRound ? { onRound: a.onRound } : {}),
      onTranscript: kept,
    });
  // Landing ends the conversation; a chunk that waits keeps it for its resume.
  if (result.finalAction === "proceed" || result.finalAction === "amend_spec") dropWorkerConversation(opts.projectDir, chunk.number);
  return result;
}
