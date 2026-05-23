import type { ParsedPlan, ParsedChunk } from "../plan-parser.js";
import { buildChunkTask, chunkAgentRole } from "../skill-mapper.js";
import { runChunkAgent } from "../agents/chunk-runner.js";
import { runChunkReviewWithJudgment, type ChunkReviewOutcome } from "../chunk-review/index.js";
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
}

export async function runChunkOnce(opts: RunChunkOnceOptions): Promise<ChunkReviewOutcome> {
  const task = buildChunkTask({
    chunk: opts.chunk,
    totalChunks: opts.totalChunks,
    planPath: opts.planPath,
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
