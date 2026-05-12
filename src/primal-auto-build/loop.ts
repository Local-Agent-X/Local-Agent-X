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

import type { ParsedPlan, ParsedChunk } from "./plan-parser.js";
import { buildChunkTask, chunkAgentRole } from "./skill-mapper.js";
import { runChunkAgent } from "./agents/chunk-runner.js";
import { runChunkReviewWithJudgment, type ChunkReviewOutcome, type ReviewAction } from "./chunk-review/index.js";
import type { JudgmentHook } from "./chunk-review/judgment-hook.js";
import { getHeadSha, gitDiffPath } from "./git-helpers.js";
import { appendHalt } from "./failure-recovery.js";
import { attemptPhaseGateScoring } from "./loop-phase-gate.js";
import { consultAdvisor } from "./advisor/index.js";
import {
  applyAdditiveSpecAmendment,
  commitChunk,
  commitSpecAmendment,
  emitLaunchReadiness,
} from "./loop-effects.js";

export type LoopEventType =
  | "chunk-start"
  | "subprocess-spawned"
  | "subprocess-returned"
  | "review-result"
  | "commit"
  | "spec-amended"
  | "launch-readiness-emitted"
  | "push-back"
  | "halt"
  | "complete";

export interface LoopEvent {
  type: LoopEventType;
  chunkNumber: number;
  totalChunks: number;
  message: string;
  data?: Record<string, unknown>;
  /** Wall-clock ms since loop start. */
  elapsedMs: number;
}

export interface LoopOptions {
  projectDir: string;
  planPath: string;
  plan: ParsedPlan;
  startingChunk: number;
  maxChunks?: number;
  signal?: AbortSignal;
  /** Optional per-event sink. Chunk 8 wires this to the LAX UI. */
  onEvent?: (event: LoopEvent) => void;
  /** Optional override for subprocess timeout per chunk. */
  subprocessTimeoutMs?: number;
  /** Chat session that owns this orchestration — propagated to chunk-worker
   *  agents so the UI can thread their activity back to the right chat. */
  parentSessionId?: string;
  /**
   * Optional LLM judgment hook. When set, fires after the mechanical
   * gates return "proceed" to catch chunk-12-style implicit-spec
   * violations. Defaults to undefined — tests pass a mock; the tool
   * passes {@link defaultJudgmentHook} from chunk-review/judgment-hook.
   * Pure no-op when undefined; never downgrades a halt/push_back/amend_spec.
   */
  judgmentHook?: JudgmentHook;
}

export interface LoopResult {
  status: "complete" | "halted";
  /** 1-indexed chunk where the loop ended. For "complete", this is the last chunk run. */
  lastChunk: number;
  /** Total chunks committed (proceed + amend_spec actions). */
  chunksCommitted: number;
  /** Halt reasoning when status === "halted". Empty when complete. */
  haltReason: string;
  /** All per-chunk review outcomes, in order. Useful for surfacing the full punch list. */
  outcomes: Array<{ chunkNumber: number; outcome: ChunkReviewOutcome; action: ReviewAction }>;
  events: LoopEvent[];
}

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
      const advice = await consultAdvisor({
        kind: "chunk-review-push-back",
        chunk,
        reviewReason: outcome.reasoning,
        workerReport: outcome.report.note || JSON.stringify(outcome.report).slice(0, 4000),
        projectDir: opts.projectDir,
      }, { signal: opts.signal });

      const adviceAction = advice?.action || "retry-with-hint";
      emit({
        type: "push-back", chunkNumber: chunk.number, totalChunks,
        message: `push-back advisor: ${adviceAction}${advice?.reasoning ? ` — ${advice.reasoning}` : " (advisor unavailable; mechanical retry)"}`,
      });

      if (adviceAction === "halt") {
        finalAction = "halt";
        finalOutcome = { ...outcome, reasoning: advice?.haltReason || outcome.reasoning };
      } else if (adviceAction === "amend-spec-additively" && advice?.specAddition) {
        const amend = await applyAdditiveSpecAmendment(opts.projectDir, chunk, advice.specAddition);
        if (!amend.ok) {
          finalAction = "halt";
          finalOutcome = { ...outcome, reasoning: `additive-diff gate rejected advisor's spec amendment: ${amend.error}` };
        } else {
          await safeGet(() => commitSpecAmendment(opts.projectDir, chunk));
          emit({ type: "spec-amended", chunkNumber: chunk.number, totalChunks, message: `advisor amended spec additively before retry` });
          const retryOutcome = await runChunkOnce({
            chunk, totalChunks, planPath: opts.planPath, plan: opts.plan,
            projectDir: opts.projectDir, preSha: preSha.value,
            subprocessTimeoutMs: opts.subprocessTimeoutMs, signal: opts.signal, emit,
            retryReason: `spec was amended to clarify: ${advice.specAddition.slice(0, 200)}`,
            judgmentHook: opts.judgmentHook,
          });
          finalOutcome = retryOutcome;
          finalAction = retryOutcome.action === "push_back" ? "halt" : retryOutcome.action;
        }
      } else {
        const retryReason = adviceAction === "retry-with-hint" && advice?.retryHint
          ? advice.retryHint
          : outcome.reasoning;
        const retryOutcome = await runChunkOnce({
          chunk, totalChunks, planPath: opts.planPath, plan: opts.plan,
          projectDir: opts.projectDir, preSha: preSha.value,
          subprocessTimeoutMs: opts.subprocessTimeoutMs, signal: opts.signal, emit,
          retryReason,
          judgmentHook: opts.judgmentHook,
        });
        finalOutcome = retryOutcome;
        finalAction = retryOutcome.action === "push_back" ? "halt" : retryOutcome.action;
        if (retryOutcome.action === "push_back") {
          emit({
            type: "halt", chunkNumber: chunk.number, totalChunks,
            message: `Chunk ${chunk.number}: push_back retry also failed — escalating to halt.`,
          });
        }
      }
    }

    // Phase-gate scoring + auto-fix push-back. Fires only when the
    // halt is from the phase-gate gate AND the project carries a
    // .primal-launch.json. Per Alex's spec: score >= 7 → proceed;
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

    switch (finalAction) {
      case "halt": {
        emit({ type: "halt", chunkNumber: chunk.number, totalChunks, message: finalOutcome.reasoning });
        const haltingFinding = finalOutcome.findings.find(f => f.action === "halt");
        appendHalt(opts.projectDir, {
          chunk: chunk.number,
          gate: haltingFinding?.gate || "",
          reason: finalOutcome.reasoning.slice(0, 200),
        });
        return {
          status: "halted",
          lastChunk: chunk.number,
          chunksCommitted,
          haltReason: finalOutcome.reasoning,
          outcomes,
          events,
        };
      }

      case "proceed": {
        const commit = await safeGet(() => commitChunk(opts.projectDir, chunk));
        if (!commit.ok) {
          return haltedResult(`commit failed for chunk ${chunk.number}: ${commit.error}`, chunk.number, outcomes, events);
        }
        chunksCommitted++;
        emit({
          type: "commit", chunkNumber: chunk.number, totalChunks,
          message: `Committed: chunk ${chunk.number} ${commit.value.committed ? "(new sha " + commit.value.sha.slice(0, 8) + ")" : "(no changes to commit — review proceeded but tree was clean)"}`,
        });
        break;
      }

      case "amend_spec": {
        const gaps = finalOutcome.report.specGaps;
        if (!gaps) {
          // Reviewer said amend_spec without supplying a SPEC_GAPS body —
          // that's a bug in the gate logic. Halt for safety.
          return haltedResult(`amend_spec returned but report.specGaps is empty — refusing to invent text`, chunk.number, outcomes, events);
        }
        const amendResult = await applyAdditiveSpecAmendment(opts.projectDir, chunk, gaps);
        if (!amendResult.ok) {
          return haltedResult(`spec amendment refused: ${amendResult.error}`, chunk.number, outcomes, events);
        }
        emit({
          type: "spec-amended", chunkNumber: chunk.number, totalChunks,
          message: `Spec amended additively: ${amendResult.value.appendedTo}`,
          data: { appendedTo: amendResult.value.appendedTo, bytes: amendResult.value.bytesAppended },
        });
        // Commit the spec change first, then any chunk code changes.
        const specCommit = await safeGet(() => commitSpecAmendment(opts.projectDir, chunk));
        if (!specCommit.ok) {
          return haltedResult(`commit of spec amendment failed for chunk ${chunk.number}: ${specCommit.error}`, chunk.number, outcomes, events);
        }
        emit({ type: "commit", chunkNumber: chunk.number, totalChunks, message: `Committed: spec amendment for chunk ${chunk.number} (sha ${specCommit.value.sha.slice(0, 8)})` });
        const codeCommit = await safeGet(() => commitChunk(opts.projectDir, chunk));
        if (!codeCommit.ok) {
          return haltedResult(`commit of chunk code failed for chunk ${chunk.number}: ${codeCommit.error}`, chunk.number, outcomes, events);
        }
        chunksCommitted++;
        emit({ type: "commit", chunkNumber: chunk.number, totalChunks, message: `Committed: chunk ${chunk.number} code (sha ${codeCommit.value.sha.slice(0, 8)})` });
        break;
      }

      case "push_back":
        // Already retried above; should not reach here. Defensive halt.
        return haltedResult(`unexpected push_back after retry for chunk ${chunk.number}`, chunk.number, outcomes, events);
    }
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

// ── chunk runner (single subprocess + review) ─────────────────────────────

interface RunChunkOnceOptions {
  chunk: ParsedChunk;
  totalChunks: number;
  planPath: string;
  plan: ParsedPlan;
  projectDir: string;
  preSha: string;
  subprocessTimeoutMs?: number;
  signal?: AbortSignal;
  emit: (e: Omit<LoopEvent, "elapsedMs">) => void;
  retryReason?: string;
  judgmentHook?: JudgmentHook;
  parentSessionId?: string;
}

async function runChunkOnce(opts: RunChunkOnceOptions): Promise<ChunkReviewOutcome> {
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

// ── result helpers ─────────────────────────────────────────────────────────

function haltedResult(reason: string, lastChunk: number, outcomes: LoopResult["outcomes"], events: LoopEvent[]): LoopResult {
  return { status: "halted", lastChunk, chunksCommitted: 0, haltReason: reason, outcomes, events };
}

async function safeGet<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try { return { ok: true, value: await fn() }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}
