/**
 * Auto-build loop — orchestrates per-chunk spawn → review → commit.
 *
 * From the design memo's "Internal loop" section. For each chunk:
 *
 *   task     = buildChunkTask(chunk, sharpenedContext, retryReason?)
 *   result   = runChunkAgent({ role, task, … })   // canonical agent path
 *   specDiff = git diff <pre-sha> -- spec/
 *   review   = runChunkReview(chunk, plan, result.stdout, specDiff)
 *
 *   proceed     → commit; advance
 *   amend_spec  → apply additive spec edit; commit separately; advance
 *   push_back   → respawn once with retryReason; if still bad, halt
 *   halt        → return now with reasoning
 *
 * The loop NEVER:
 *   - Auto-applies a non-additive spec amendment (the additive-diff gate
 *     halts before we get here, but defense in depth — we re-check.)
 *   - Auto-drives phase-gate scenarios (halts and asks user to drive).
 *   - Auto-pushes to a remote (commit only).
 *   - Retries a halted chunk a second time.
 */

import { getHeadSha } from "../git-helpers.js";
import { attemptPhaseGateScoring } from "../loop-phase-gate.js";
import { emitLaunchReadiness } from "../loop-effects.js";
import type { LoopEvent, LoopOptions, LoopResult } from "./types.js";
import { haltedResult, safeGet } from "./types.js";
import { runChunkOnce } from "./run-chunk-once.js";
import { handlePushBack } from "./handle-push-back.js";
import { handleAction } from "./handle-action.js";

export async function runBuildLoop(opts: LoopOptions): Promise<LoopResult> {
  const startedAt = Date.now();
  const events: LoopEvent[] = [];
  const outcomes: LoopResult["outcomes"] = [];

  const emit = (e: Omit<LoopEvent, "elapsedMs">) => {
    const event: LoopEvent = { ...e, elapsedMs: Date.now() - startedAt };
    events.push(event);
    try { opts.onEvent?.(event); } catch { /* event sink must not crash the loop */ }
  };

  const chunks = opts.plan.chunks;
  const totalChunks = chunks.length;
  const startIdx = chunks.findIndex(c => c.number === opts.startingChunk);
  if (startIdx < 0) {
    return haltedResult(`starting_chunk=${opts.startingChunk} not found in plan (plan has ${totalChunks} chunks)`, 0, outcomes, events);
  }

  const endIdx = opts.maxChunks ? Math.min(startIdx + opts.maxChunks, totalChunks) : totalChunks;
  let chunksCommitted = 0;

  for (let i = startIdx; i < endIdx; i++) {
    if (opts.signal?.aborted) {
      return haltedResult("loop aborted by signal", chunks[i].number, outcomes, events);
    }

    const chunk = chunks[i];
    emit({ type: "chunk-start", chunkNumber: chunk.number, totalChunks, message: `Starting chunk ${chunk.number}/${totalChunks}: ${chunk.title} (${chunk.klass})` });

    const preSha = await safeGet(() => getHeadSha(opts.projectDir));
    if (!preSha.ok) {
      return haltedResult(`git rev-parse HEAD failed before chunk ${chunk.number}: ${preSha.error}`, chunk.number, outcomes, events);
    }

    const outcome = await runChunkOnce({
      chunk,
      totalChunks,
      planPath: opts.planPath,
      plan: opts.plan,
      projectDir: opts.projectDir,
      preSha: preSha.value,
      subprocessTimeoutMs: opts.subprocessTimeoutMs,
      signal: opts.signal,
      emit,
      retryReason: undefined,
      judgmentHook: opts.judgmentHook,
      parentSessionId: opts.parentSessionId,
    });

    let finalOutcome = outcome;
    let finalAction = outcome.action;

    if (outcome.action === "push_back") {
      const pb = await handlePushBack({
        chunk, totalChunks,
        planPath: opts.planPath, plan: opts.plan,
        projectDir: opts.projectDir, preSha: preSha.value,
        subprocessTimeoutMs: opts.subprocessTimeoutMs, signal: opts.signal, emit,
        judgmentHook: opts.judgmentHook,
        outcome,
      });
      finalOutcome = pb.finalOutcome;
      finalAction = pb.finalAction;
    }

    // Phase-gate scoring + auto-fix push-back. Fires only when the
    // halt is from the phase-gate gate AND the project carries a
    // .primal-launch.json. Per spec: score >= 7 → proceed;
    // score < 7 → spawn one fix-worker, re-score, halt if still < 7.
    if (finalAction === "halt" && finalOutcome.findings.some(f => f.gate === "phase-gate")) {
      const recovery = await attemptPhaseGateScoring(opts, chunk, emit, totalChunks);
      if (recovery.kind === "recovered") {
        finalAction = "proceed";
        emit({ type: "review-result", chunkNumber: chunk.number, totalChunks, message: `phase-gate auto-scoring passed — overriding halt to proceed` });
      } else if (recovery.kind === "halt-with-context") {
        finalOutcome = { ...finalOutcome, reasoning: recovery.reason };
      }
      // kind === "no-spec" → leave the halt unchanged for manual scoring.
    }

    outcomes.push({ chunkNumber: chunk.number, outcome: finalOutcome, action: finalAction });

    // Surface launch-readiness items regardless of action (they don't
    // halt by default — the launch-readiness gate halts only when items
    // are vague). When they're concrete, append them now.
    if (finalOutcome.report.launchReadiness) {
      emitLaunchReadiness(opts.projectDir, chunk, finalOutcome.report.launchReadiness);
      emit({
        type: "launch-readiness-emitted", chunkNumber: chunk.number, totalChunks,
        message: `Launch-readiness item recorded.`,
        data: { item: finalOutcome.report.launchReadiness.slice(0, 200) },
      });
    }

    const handled = await handleAction({
      chunk, totalChunks,
      projectDir: opts.projectDir,
      finalAction, finalOutcome,
      chunksCommitted, outcomes, events, emit,
    });
    if (handled.kind === "halt") return handled.result;
    chunksCommitted = handled.chunksCommitted;
  }

  emit({ type: "complete", chunkNumber: chunks[endIdx - 1].number, totalChunks, message: `Loop complete: ${chunksCommitted} chunks committed.` });
  return {
    status: "complete",
    lastChunk: chunks[endIdx - 1].number,
    chunksCommitted,
    haltReason: "",
    outcomes,
    events,
  };
}
