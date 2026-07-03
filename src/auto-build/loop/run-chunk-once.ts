import type { ParsedPlan, ParsedChunk } from "../plan-parser.js";
import { buildChunkTask, chunkAgentRole, distillSharpenedContext } from "../skill-mapper.js";
import { runChunkAgent } from "../agents/chunk-runner.js";
import { runChunkReviewWithJudgment, type ChunkReviewOutcome } from "../chunk-review/index.js";
import { parseChunkReport } from "../chunk-review/report-parser.js";
import type { ReviewAction } from "../chunk-review/gates.js";
import type { JudgmentHook } from "../chunk-review/judgment-hook.js";
import { gitDiffPath } from "../git-helpers.js";
import type { EmitFn } from "./types.js";

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
  judgmentHook?: JudgmentHook;
  parentSessionId?: string;
  /**
   * Outcomes of already-completed chunks, in plan order. Distilled into the
   * per-chunk "sharpened context" block so each worker inherits earlier
   * chunks' SPEC_GAPS / NOTE learnings instead of rediscovering the project
   * from zero. Omitted (or empty) for the first chunk.
   */
  priorOutcomes?: Array<{ chunkNumber: number; outcome: ChunkReviewOutcome }>;
}

/** Minimal chunk-agent result shape this decision needs. */
interface ChunkExitInfo {
  exitCode: number;
  durationMs: number;
  error?: string;
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
  const detail = subResult.error?.trim()
    || (timedOut ? "timed out" : "process exited without producing a report");
  const action: ReviewAction = aborted ? "halt" : "push_back";
  const reasoning = aborted
    ? `Chunk ${chunkNumber} cancelled — agent aborted (exit ${subResult.exitCode}) before producing a report.`
    : `Chunk ${chunkNumber} agent failed before producing a report: ${detail} (exit ${subResult.exitCode}, ${subResult.durationMs}ms).`;
  return {
    action,
    reasoning,
    findings: [{ gate: "report-shape", action, reasoning }],
    report: parseChunkReport(""),
  };
}

export async function runChunkOnce(opts: RunChunkOnceOptions): Promise<ChunkReviewOutcome> {
  const sharpenedContext = opts.priorOutcomes && opts.priorOutcomes.length > 0
    ? distillSharpenedContext(
        opts.priorOutcomes.map(o => ({ chunkNumber: o.chunkNumber, report: o.outcome.report })),
      )
    : undefined;

  const task = buildChunkTask({
    chunk: opts.chunk,
    totalChunks: opts.totalChunks,
    planPath: opts.planPath,
    sharpenedContext,
    retryReason: opts.retryReason,
  });
  const role = chunkAgentRole(opts.chunk.klass);

  opts.emit({
    type: "subprocess-spawned",
    chunkNumber: opts.chunk.number,
    totalChunks: opts.totalChunks,
    message: `Invoked agent ${role}${opts.retryReason ? " — retry" : ""}`,
  });

  const subResult = await runChunkAgent({
    role,
    task,
    projectDir: opts.projectDir,
    timeoutMs: opts.subprocessTimeoutMs,
    signal: opts.signal,
    parentSessionId: opts.parentSessionId,
  });

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
    subResult,
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
    rawReport: subResult.stdout,
    specDiff,
    projectDir: opts.projectDir,
  }, opts.judgmentHook, opts.signal);

  opts.emit({
    type: "review-result",
    chunkNumber: opts.chunk.number,
    totalChunks: opts.totalChunks,
    message: `Review: ${outcome.action} — ${outcome.reasoning}`,
    data: { findings: outcome.findings.map(f => ({ gate: f.gate, action: f.action })) },
  });

  return outcome;
}
