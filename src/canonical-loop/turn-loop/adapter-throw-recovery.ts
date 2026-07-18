/**
 * Recovery for a THROWN adapter error — a provider HTTP/stream timeout the
 * adapter did NOT convert into a kind:"error" report (e.g. "xai call threw:
 * The operation was aborted due to timeout"). A throw must NOT escape
 * driveTurn: escaping skips the terminal path, so the op never finalizes and
 * the chat "thinking…" spinner hangs forever (live failure 2026-06-19, Grok
 * stall).
 *
 * Recover the way TOOL failures already do (tool-failure-summary.ts): feed the
 * error back to the model as a synthetic user nudge and CONTINUE the loop
 * (terminalReason=null) so it resumes from committed state on the next turn.
 * Bounded by ADAPTER_ERROR_CAP — a hard-down provider would otherwise spin the
 * whole wall-clock budget. After the cap, fall through to a terminal "error"
 * (the floor) so the op finalizes and the spinner clears with a visible reason.
 */
import type { Op } from "../../ops/types.js";
import type { DriveTurnResult } from "./types.js";
import { emit, publishStreamChunk } from "../event-emitter.js";
import { transitionOp } from "../state-machine.js";
import { appendNudgeAsUserMessage } from "./nudges.js";
import { classify } from "../../errors/classifier.js";
import { forceCompactNext } from "./compact-history.js";

const adapterThrowStreaks = new Map<string, number>();
const ADAPTER_ERROR_CAP = 2;

// Context-overflow recovery attempts, tracked SEPARATELY from the throw
// streak: an overflow arrives either as a throw or as a reported kind:"error"
// (which clears the throw streak), so it needs its own bound or the
// force-compact-and-retry loop could spin.
const overflowAttempts = new Map<string, number>();
const OVERFLOW_RETRY_CAP = 2;

/** The model call returned (success or reported error) — provider is responding again. */
export function clearAdapterThrowStreak(opId: string): void {
  adapterThrowStreaks.delete(opId);
}

/** The turn actually succeeded (no adapter error) — overflow is resolved. */
export function clearOverflowAttempts(opId: string): void {
  overflowAttempts.delete(opId);
}

/**
 * Provider rejected the call as over-window (context_overflow / 413 /
 * "prompt too long"). The pre-call estimate demonstrably undershot, so mark
 * the op for FORCED compaction on the next build-input and continue the loop
 * — the retry rebuilds its view through compactHistory with the threshold
 * bypassed. No resume-nudge here: appending a message to an already-
 * overflowing context makes the overflow worse. Bounded: after
 * OVERFLOW_RETRY_CAP forced-compact retries still overflowing, returns null
 * so the caller falls through to its normal terminal handling.
 */
export function recoverContextOverflow(op: Op, message: string, _turnIdx: number): DriveTurnResult | null {
  const attempts = (overflowAttempts.get(op.id) ?? 0) + 1;
  if (attempts > OVERFLOW_RETRY_CAP) {
    overflowAttempts.delete(op.id);
    return null;
  }
  overflowAttempts.set(op.id, attempts);
  forceCompactNext(op.id);
  // Retract this turn's rendered-but-uncommitted partial so user-view matches
  // the committed history the retry rebuilds from.
  publishStreamChunk(op.id, { replace: true, text: "" });
  emit(op.id, "error", {
    code: "context_overflow_compacting",
    message: `Context exceeded the model's window — compacting older history and retrying (${attempts}/${OVERFLOW_RETRY_CAP}). ${message}`,
    retryable: true,
  });
  return { terminalReason: null, toolCount: 0, messageCount: 0, cancelled: false };
}

export function recoverAdapterThrow(op: Op, e: unknown, turnIdx: number): DriveTurnResult {
  const message = e instanceof Error ? e.message : String(e);
  // Over-window errors get the compaction recovery, not the resume-nudge: the
  // nudge ADDS tokens to a context the provider just rejected as too big, so
  // the generic path can never succeed for this class.
  if (classify(e).recovery === "compress") {
    const recovered = recoverContextOverflow(op, message, turnIdx);
    if (recovered) return recovered;
  }
  const streak = (adapterThrowStreaks.get(op.id) ?? 0) + 1;
  if (streak <= ADAPTER_ERROR_CAP) {
    adapterThrowStreaks.set(op.id, streak);
    // Retract this turn's rendered-but-uncommitted partial (replace:true) so
    // user-view matches the empty committed history the resume-nudge assumes.
    publishStreamChunk(op.id, { replace: true, text: "" });
    emit(op.id, "error", { code: "adapter_retry", message: `${message} — retrying (${streak}/${ADAPTER_ERROR_CAP})`, retryable: true });
    appendNudgeAsUserMessage(
      op.id,
      turnIdx + 1,
      `Your previous step did not complete — it hit a transient provider error: ${message}. This is not a mistake on your part. Resume exactly where you left off and finish the task; do not restart from scratch.`,
    );
    return { terminalReason: null, toolCount: 0, messageCount: 0, cancelled: false };
  }
  adapterThrowStreaks.delete(op.id);
  emit(op.id, "error", { code: "adapter_error_exhausted", message: `The model provider failed ${ADAPTER_ERROR_CAP + 1} times in a row (last: ${message}). Stopping — retry, or switch to a more reliable model.`, retryable: false });
  // commitTurn (the normal terminal path) is what transitions running →
  // failed, and this early return skips it — so fail the op explicitly here,
  // or it would stay "running" and re-create the very hang this fixes.
  transitionOp(op, "failed", "adapter_error_exhausted", { learnedOutcome: "aborted" });
  return { terminalReason: "error", toolCount: 0, messageCount: 0, cancelled: false };
}
