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

const adapterThrowStreaks = new Map<string, number>();
const ADAPTER_ERROR_CAP = 2;

/** The model call returned (success or reported error) — provider is responding again. */
export function clearAdapterThrowStreak(opId: string): void {
  adapterThrowStreaks.delete(opId);
}

export function recoverAdapterThrow(op: Op, e: unknown, turnIdx: number): DriveTurnResult {
  const message = e instanceof Error ? e.message : String(e);
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
  transitionOp(op, "failed", "adapter_error_exhausted");
  return { terminalReason: "error", toolCount: 0, messageCount: 0, cancelled: false };
}
