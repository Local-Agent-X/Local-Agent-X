import type { ParsedPlan, ParsedChunk } from "../plan-parser.js";
import type { ChunkReviewOutcome, ReviewAction } from "../chunk-review/index.js";
import type { JudgmentHook } from "../chunk-review/judgment-hook.js";
import { consultAdvisor } from "../advisor/index.js";
import { applyAdditiveSpecAmendment, commitSpecAmendment } from "../loop-effects.js";
import type { EmitFn } from "./types.js";
import { safeGet } from "./types.js";
import { runChunkOnce } from "./run-chunk-once.js";
import { parsePlanFile } from "../plan-parser.js";

export interface HandlePushBackOptions {
  chunk: ParsedChunk;
  totalChunks: number;
  planPath: string;
  plan: ParsedPlan;
  projectDir: string;
  preSha: string;
  subprocessTimeoutMs?: number;
  signal?: AbortSignal;
  emit: EmitFn;
  judgmentHook?: JudgmentHook;
  outcome: ChunkReviewOutcome;
}

export interface HandlePushBackResult {
  finalOutcome: ChunkReviewOutcome;
  finalAction: ReviewAction;
}

export async function handlePushBack(opts: HandlePushBackOptions): Promise<HandlePushBackResult> {
  const { chunk, totalChunks, outcome, emit } = opts;

  const advice = await consultAdvisor({
    kind: "chunk-review-push-back",
    chunk,
    reviewReason: outcome.reasoning,
    workerReport:
      `NOTE: ${outcome.report.note || "(empty)"}\n` +
      `SPEC_GAPS: ${outcome.report.specGaps || "(empty)"}\n` +
      `DONE_WHEN: ${outcome.report.doneWhen}`,
    projectDir: opts.projectDir,
  }, { signal: opts.signal });

  const adviceAction = advice?.action || "retry-with-hint";
  emit({
    type: "push-back", chunkNumber: chunk.number, totalChunks,
    message: `push-back advisor: ${adviceAction}${advice?.reasoning ? ` — ${advice.reasoning}` : " (advisor unavailable; mechanical retry)"}`,
  });

  if (adviceAction === "halt") {
    return {
      finalAction: "halt",
      finalOutcome: { ...outcome, reasoning: advice?.haltReason || outcome.reasoning },
    };
  }

  if (adviceAction === "amend-spec-additively" && advice?.specAddition) {
    const amend = await applyAdditiveSpecAmendment(opts.projectDir, chunk, advice.specAddition);
    if (!amend.ok) {
      return {
        finalAction: "halt",
        finalOutcome: { ...outcome, reasoning: `additive-diff gate rejected advisor's spec amendment: ${amend.error}` },
      };
    }
    await safeGet(() => commitSpecAmendment(opts.projectDir, chunk));
    emit({ type: "spec-amended", chunkNumber: chunk.number, totalChunks, message: `advisor amended spec additively before retry` });
    // The amendment may sharpen the current chunk's Slice/Done when. Reparse
    // before retry so the worker and review gates use the amended contract,
    // not the stale object captured at build kickoff.
    let refreshedPlan: ParsedPlan;
    let refreshedChunk: ParsedChunk;
    try {
      refreshedPlan = parsePlanFile(opts.planPath);
      refreshedChunk = refreshedPlan.chunks.find((c) => c.number === chunk.number) ?? chunk;
    } catch (e) {
      return {
        finalAction: "halt",
        finalOutcome: { ...outcome, reasoning: `spec amendment left plan invalid: ${(e as Error).message}` },
      };
    }
    const retryOutcome = await runChunkOnce({
      chunk: refreshedChunk, totalChunks, planPath: opts.planPath, plan: refreshedPlan,
      projectDir: opts.projectDir, preSha: opts.preSha,
      subprocessTimeoutMs: opts.subprocessTimeoutMs, signal: opts.signal, emit,
      retryReason: `spec was amended to clarify: ${advice.specAddition.slice(0, 200)}`,
      judgmentHook: opts.judgmentHook,
    });
    return {
      finalOutcome: retryOutcome,
      finalAction: retryOutcome.action === "push_back" ? "halt" : retryOutcome.action,
    };
  }

  const retryReason = adviceAction === "retry-with-hint" && advice?.retryHint
    ? advice.retryHint
    : outcome.reasoning;
  const retryOutcome = await runChunkOnce({
    chunk, totalChunks, planPath: opts.planPath, plan: opts.plan,
    projectDir: opts.projectDir, preSha: opts.preSha,
    subprocessTimeoutMs: opts.subprocessTimeoutMs, signal: opts.signal, emit,
    retryReason,
    judgmentHook: opts.judgmentHook,
  });
  const finalAction: ReviewAction = retryOutcome.action === "push_back" ? "halt" : retryOutcome.action;
  if (retryOutcome.action === "push_back") {
    emit({
      type: "halt", chunkNumber: chunk.number, totalChunks,
      message: `Chunk ${chunk.number}: push_back retry also failed — escalating to halt.`,
    });
  }
  return { finalOutcome: retryOutcome, finalAction };
}
