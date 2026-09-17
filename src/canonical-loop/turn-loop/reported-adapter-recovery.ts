import type { Op } from "../../ops/types.js";
import { classify } from "../../errors/classifier.js";
import { CONTEXT_WINDOW_EXCEEDED_CODE } from "../adapter-contract.js";
import { clearOverflowAttempts, recoverContextOverflow } from "./adapter-throw-recovery.js";
import type { DriveTurnResult } from "./types.js";

interface ReportedAdapterError {
  code: string;
  message: string;
  retryable: boolean;
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
    && (error.code === CONTEXT_WINDOW_EXCEEDED_CODE || classify(error.message).recovery === "compress");
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
