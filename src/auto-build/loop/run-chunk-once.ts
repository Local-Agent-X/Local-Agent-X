import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { FIX_THE_CLASS } from "../chunk-review/skeptic-bar.js";
import type { ParsedPlan, ParsedChunk } from "../plan-parser.js";
import { buildChunkTask, chunkAgentRole, distillSharpenedContext } from "../skill-mapper.js";
import { runChunkAgent } from "../agents/chunk-runner.js";
import { runChunkReviewWithJudgment, type ChunkReviewOutcome } from "../chunk-review/index.js";
import { chunkReportOf } from "../chunk-review/chunk-report.js";
import type { ReviewAction } from "../chunk-review/gates.js";
import type { JudgmentHook } from "../chunk-review/judgment-hook.js";
import { chunkJudgingSummary, type ChunkJudge } from "../chunk-review/chunk-verdict.js";
import { chunkChangedFiles, gitDiffPath } from "../git-helpers.js";
import type { EmitFn } from "./types.js";
import { carriedConversation } from "./worker-conversation.js";

export interface RunChunkOnceOptions {
  chunk: ParsedChunk;
  totalChunks: number;
  planPath: string;
  plan: ParsedPlan;
  projectDir: string;
  preSha: string;
  subprocessTimeoutMs?: number;
  signal?: AbortSignal;
  emit: EmitFn;
  retryReason?: string;
  /** What earlier reviews sent this chunk back for: its review is then a
   *  recheck of those findings (chunk-review/skeptic-bar.ts). */
  earlierFindings?: readonly string[];
  judgmentHook?: JudgmentHook;
  parentSessionId?: string;
  /** Orchestrator op id — threaded to the chunk worker's spawn as its
   *  parentAgentId so its AGENTS-panel card nests under the orchestrator card.
   *  Undefined for non-orchestrator callers → worker card renders as a root. */
  parentOpId?: string;
  /**
   * Outcomes of already-completed chunks, in plan order. Distilled into the
   * per-chunk "sharpened context" block so each worker inherits earlier
   * chunks' SPEC_GAPS / NOTE learnings instead of rediscovering the project
   * from zero. Omitted (or empty) for the first chunk.
   */
  priorOutcomes?: Array<{ chunkNumber: number; outcome: ChunkReviewOutcome }>;
  /**
   * Parallel-path only (S3): the 0-based index of this chunk within its
   * concurrently-dispatched batch. Threaded so the per-chunk gate's app launch
   * (S5's allocatePort) can pick a UNIQUE dev-server port per concurrent build
   * and avoid a same-port collision. 0 / undefined = the serial single-build
   * path (byte-identical to today). See loop/parallel-waves.ts.
   *
   * The chunk judge (chunk-review/chunk-judge.ts) carries it to
   * scoreScenarioFiles → launchApp(workerIndex), so concurrent chunks score
   * against servers on distinct ports.
   */
  workerIndex?: number;
  /** Judge the chunk against its held-out scenarios and a skeptic before it
   *  counts (chunk-review/chunk-judge.ts). Absent → not judged. */
  chunkJudge?: ChunkJudge;
  /** The project the build is for, when `projectDir` is a worktree of it: the
   *  judge finds the sealed suite by this folder's name. Defaults to projectDir. */
  baseProjectDir?: string;
  /** The conversation of the worker that built the last round: this round is
   *  that worker going on, told only what the review found (retryReason). */
  continueFrom?: ChatCompletionMessageParam[];
  /** `continueFrom` is the conversation kept across a Pause or a restart, not
   *  a fix round: the worker is told it goes on, not that it was sent back. */
  resumed?: boolean;
  /** Called with this round's worker conversation when it finished, so the
   *  next round can go on from it. */
  onTranscript?: (messages: ChatCompletionMessageParam[]) => void;
}

/** What the worker is told: the whole brief, or, to the worker that built the
 *  last round, what the review found. */
/** What a chunk's worker is called. A finish-check fix chunk is numbered past
 *  the plan (finish-gates/run.ts: 1000 + round * 10 + n), so it is named by its
 *  place in its round, "Finish fix 1: hostile findings (1 of 4)", where the
 *  AGENTS panel read "Chunk 1011/4" (2026-11-25). */
export function chunkLabel(opts: Pick<RunChunkOnceOptions, "chunk" | "plan" | "totalChunks">): string {
  if (opts.chunk.phase !== "Finish") return `Chunk ${opts.chunk.number}/${opts.totalChunks}: ${opts.chunk.title}`;
  const at = opts.plan.chunks.findIndex((c) => c.number === opts.chunk.number) + 1;
  return `${opts.chunk.title} (${at} of ${opts.totalChunks})`;
}

function workerTask(opts: RunChunkOnceOptions): string {
  if (opts.continueFrom && opts.resumed) {
    return `LAX was paused or restarted while you were building this chunk, and now goes on. ${opts.retryReason ?? ""}\n\n` +
      "You are the same worker: what you read and decided is above, and your files are as you left them (the last ones " +
      "may be half-written). Check where you were (git status, git diff), finish the chunk, run the checks the done-when " +
      "names, and end by calling chunk_report.";
  }
  if (opts.continueFrom) {
    return `The review sent your chunk back. ${opts.retryReason ?? ""}\n\n` +
      `Fix that in the same project. ${FIX_THE_CLASS} Keep what you already fixed, run the checks the done-when names, and end ` +
      "by calling chunk_report again: your earlier report is replaced by this one.";
  }
  const sharpenedContext = opts.priorOutcomes && opts.priorOutcomes.length > 0
    ? distillSharpenedContext(
        opts.priorOutcomes.map(o => ({ chunkNumber: o.chunkNumber, report: o.outcome.report, structureNote: o.outcome.structureNote })),
      )
    : undefined;
  return buildChunkTask({
    chunk: opts.chunk,
    totalChunks: opts.totalChunks,
    planPath: opts.planPath,
    sharpenedContext,
    retryReason: opts.retryReason,
  });
}

/** Minimal chunk-agent result shape this decision needs. */
interface ChunkExitInfo {
  exitCode: number;
  durationMs: number;
  error?: string;
  /** The worker called chunk_report before its run ended. */
  reported?: boolean;
}

/**
 * Decide the review outcome for a chunk agent that did NOT exit cleanly.
 * Returns `null` on a clean exit (exit 0) so the caller proceeds to normal
 * report review. Pure + exported so the crash / timeout / abort → action
 * mapping is unit-testable without spawning a subprocess.
 *
 * - abort (exit 130, or the caller's signal already aborted) → `halt`: a
 *   user cancel must NOT be respawned by the push_back retry machinery.
 * - crash / timeout (any other non-zero) → `push_back`: the loop's
 *   retry-once machinery respawns, but for an honest reason (the exit code
 *   and error), not a phantom "no parseable report" shape failure.
 */
export function chunkProcessFailureOutcome(
  chunkNumber: number,
  subResult: ChunkExitInfo,
  signalAborted: boolean,
): ChunkReviewOutcome | null {
  if (subResult.exitCode === 0) return null;
  const aborted = subResult.exitCode === 130 || signalAborted;
  const timedOut = subResult.exitCode === 124;
  // It reported and its run was then marked failed (a guard on its last
  // words): the work is there to be measured, so it is, not built again.
  if (subResult.reported && !aborted && !timedOut) return null;
  const detail = subResult.error?.trim()
    || (timedOut ? "timed out" : "process exited without producing a report");
  const action: ReviewAction = aborted ? "halt" : "push_back";
  const reasoning = aborted
    ? `Chunk ${chunkNumber} cancelled — agent aborted (exit ${subResult.exitCode}) before producing a report.`
    : `Chunk ${chunkNumber} agent failed before producing a report: ${detail} (exit ${subResult.exitCode}, ${subResult.durationMs}ms).`;
  return {
    action,
    reasoning,
    findings: [{ gate: "worker-run", action, reasoning }],
    report: chunkReportOf(undefined),
  };
}

/** The owner paused or stopped the build while the chunk was being reviewed.
 *  A judge cut off mid-run has not judged, so the review's verdict does not
 *  stand: label-check-grok's fix chunk 1015 landed as "All gates passed" after
 *  a Pause aborted its skeptic (2026-11-27). The chunk halts like any stopped
 *  one, its work is kept, and it is reviewed again when the build goes on. */
export function interruptedReviewOutcome(chunkNumber: number): ChunkReviewOutcome {
  const reasoning = `Chunk ${chunkNumber} was stopped during its review; it is not landed on a review that did not finish, and is reviewed again when the build goes on.`;
  return { action: "halt", reasoning, findings: [{ gate: "worker-run", action: "halt", reasoning }], report: chunkReportOf(undefined) };
}

export async function runChunkOnce(opts: RunChunkOnceOptions): Promise<ChunkReviewOutcome> {
  const task = workerTask(opts);
  const role = chunkAgentRole(opts.chunk.klass);

  opts.emit({
    type: "subprocess-spawned",
    chunkNumber: opts.chunk.number,
    totalChunks: opts.totalChunks,
    message: `Invoked agent ${role}${opts.continueFrom ? " — the same worker, going on" : opts.retryReason ? " — retry" : ""}`,
    ...(opts.workerIndex !== undefined ? { data: { workerIndex: opts.workerIndex } } : {}),
  });

  const subResult = await runChunkAgent({
    role,
    task,
    title: `${chunkLabel(opts)}${opts.retryReason ? " (retry)" : ""}`,
    projectDir: opts.projectDir,
    silenceLimitMs: opts.subprocessTimeoutMs,
    signal: opts.signal,
    parentSessionId: opts.parentSessionId,
    parentOpId: opts.parentOpId,
    ...(opts.continueFrom ? { priorMessages: carriedConversation(opts.continueFrom) } : {}),
    ...(opts.onTranscript ? { keepTranscript: true } : {}),
    ...(opts.chunk.footprint?.length ? { touches: opts.chunk.footprint } : {}),
  });
  if (subResult.transcript) opts.onTranscript?.(subResult.transcript);

  opts.emit({
    type: "subprocess-returned",
    chunkNumber: opts.chunk.number,
    totalChunks: opts.totalChunks,
    message: `Agent returned (exit=${subResult.exitCode}, ${subResult.durationMs}ms, ${subResult.stdout.length} chars)`,
  });

  // Process-level failure: the agent crashed, timed out, or was aborted, so
  // its stdout is empty/garbage. Feeding that to the report parser mislabels
  // the run as "no parseable report" and — worse — a user-cancelled build
  // (exit 130 / aborted signal) parses to the same empty report and gets
  // RETRIED by the push_back machinery. Branch on the exit code first.
  const processFailure = chunkProcessFailureOutcome(
    opts.chunk.number,
    { ...subResult, reported: subResult.chunkReport !== undefined },
    opts.signal?.aborted === true,
  );
  if (processFailure) {
    opts.emit({
      type: "review-result",
      chunkNumber: opts.chunk.number,
      totalChunks: opts.totalChunks,
      message: `Review: ${processFailure.action} — ${processFailure.reasoning}`,
      data: { findings: processFailure.findings.map(f => ({ gate: f.gate, action: f.action })) },
    });
    return processFailure;
  }

  // Capture spec/ diff since chunk start. The agent SHOULDN'T have
  // touched spec/, but we capture defensively — if it did, the
  // additive-diff gate will catch any weakening.
  let specDiff = "";
  try {
    specDiff = await gitDiffPath(opts.projectDir, opts.preSha, "spec/");
  } catch {
    // Best-effort. If spec/ doesn't exist or git fails, we treat diff as empty.
  }

  const outcome = await runChunkReviewWithJudgment({
    chunk: opts.chunk,
    allChunks: opts.plan.chunks,
    plan: opts.plan,
    report: subResult.chunkReport,
    changed: await chunkChangedFiles(opts.projectDir, opts.preSha).catch(() => []),
    specDiff,
    projectDir: opts.projectDir,
    ledgerDir: opts.baseProjectDir ?? opts.projectDir,
    chunkJudge: opts.chunkJudge ? {
      judge: opts.chunkJudge,
      preSha: opts.preSha,
      ...(opts.earlierFindings?.length ? { earlierFindings: opts.earlierFindings } : {}),
      baseProjectDir: opts.baseProjectDir ?? opts.projectDir,
      workerIndex: opts.workerIndex,
      parentSessionId: opts.parentSessionId,
      parentOpId: opts.parentOpId,
      onProgress: (msg) => opts.emit({ type: "review-result", chunkNumber: opts.chunk.number, totalChunks: opts.totalChunks, message: `[judge] ${msg}` }),
    } : undefined,
  }, opts.judgmentHook, opts.signal);
  if (opts.signal?.aborted) {
    const stopped = interruptedReviewOutcome(opts.chunk.number);
    opts.emit({ type: "review-result", chunkNumber: opts.chunk.number, totalChunks: opts.totalChunks, message: `Review: halt — ${stopped.reasoning}` });
    return stopped;
  }

  for (const owed of outcome.owed ?? []) {
    opts.emit({ type: "review-result", chunkNumber: opts.chunk.number, totalChunks: opts.totalChunks, message: `Chunk ${opts.chunk.number} unverified: ${owed.why}` });
  }
  if (outcome.judging) {
    opts.emit({
      type: "review-result",
      chunkNumber: opts.chunk.number,
      totalChunks: opts.totalChunks,
      message: `Chunk ${opts.chunk.number} judged: ${chunkJudgingSummary(outcome.judging)}`,
      data: { judging: outcome.judging },
    });
  }

  opts.emit({
    type: "review-result",
    chunkNumber: opts.chunk.number,
    totalChunks: opts.totalChunks,
    message: `Review: ${outcome.action} — ${outcome.reasoning}`,
    data: { findings: outcome.findings.map(f => ({ gate: f.gate, action: f.action })) },
  });

  return outcome;
}
