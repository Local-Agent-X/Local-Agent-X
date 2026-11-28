import type { Op } from "../../ops/types.js";
import { classify, isRetryable } from "../../resilience-policy.js";
import { CONTEXT_WINDOW_EXCEEDED_CODE } from "../adapter-contract.js";
import { clearOverflowAttempts, recoverContextOverflow } from "./adapter-throw-recovery.js";
import type { DriveTurnResult } from "./types.js";

interface ReportedAdapterError {
  code: string;
  message: string;
  retryable: boolean;
}

/**
 * A reported transient failure (a connection dropped, a timeout, an overload)
 * in a turn that finalized no message and asked for no tool: the thrown-error
 * case in another shape, recovered the same way (recoverAdapterThrow: retract
 * the partial, resume, bounded). The transport's own retry stops once anything
 * has streamed, so it is not double-emitted (adapters/transport-retry.ts);
 * the turn loop then failed the whole op on a dropped connection, 36 minutes
 * and 165k output tokens in (glasses chat, 2026-11-27). Nothing in the turn
 * was committed, so redoing it repeats nothing. A report the transport marked
 * retryable before any output keeps the worker's re-queue below.
 */
export function isDroppedTurn(
  error: ReportedAdapterError | null,
  activity: { streamed: boolean; finalized: number; toolCalls: number; observedTools: number },
): error is ReportedAdapterError {
  if (!error || error.code === CONTEXT_WINDOW_EXCEEDED_CODE) return false;
  if (activity.finalized > 0 || activity.toolCalls > 0 || activity.observedTools > 0) return false;
  if (error.retryable && !activity.streamed) return false;
  return isRetryable({ message: error.message });
}

export function recoverReportedAdapterError(
  op: Op,
  error: ReportedAdapterError | null,
  turnIdx: number,
  activity: { streamed: boolean; finalized: number; toolCalls: number; observedTools: number },
): DriveTurnResult | undefined {
  // The adapter's own measured refusal is identified by its code; a provider's
  // rejection only by its wording. Both are the same overflow.
  const overWindow = error !== null
    && (error.code === CONTEXT_WINDOW_EXCEEDED_CODE || classify(error.message) === "contextOverflow");
  if (error && overWindow) {
    const recovered = recoverContextOverflow(op, error.message, turnIdx);
    if (recovered) return recovered;
  }
  if (!error) clearOverflowAttempts(op.id);
  if (!error?.retryable || activity.streamed || activity.finalized > 0
    || activity.toolCalls > 0 || activity.observedTools > 0) return undefined;
  return {
    terminalReason: null,
    toolCount: 0,
    messageCount: 0,
    cancelled: false,
    retryCode: error.code,
    retryMessage: error.message,
  };
}
