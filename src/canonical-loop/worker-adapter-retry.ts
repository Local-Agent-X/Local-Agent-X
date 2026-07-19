import { decideRecovery } from "../ops/heartbeat.js";
import type { Op } from "../ops/types.js";
import { emit } from "./event-emitter.js";
import { persistOpKeepingSignals } from "./op-persist.js";
import { transitionOp } from "./state-machine.js";
import { recordTerminalOutcome } from "./turn-loop/record-outcome.js";
import type { CanonicalLane } from "./types.js";

export async function handleAdapterRetry(op: Op, reportedCode: string): Promise<"retrying" | "exhausted"> {
  const code = safeRetryCode(reportedCode);
  const decision = decideRecovery(op, {
    committingCallsAlreadyMade: false,
    reason: `adapter:${code}`,
  });
  const now = Date.now();
  op.lastFailureAt = new Date(now).toISOString();
  if (!decision.shouldRetry) {
    op.lastFailureReason = `adapter_retry_exhausted:${code}`;
    persistOpKeepingSignals(op);
    emit(op.id, "error", {
      code: "adapter_retry_exhausted",
      message: "The adapter remained unavailable after its bounded autonomous recovery attempts.",
      retryable: false,
    });
    recordTerminalOutcome(op, "aborted");
    transitionOp(op, "failed", "adapter_retry_exhausted", { learnedOutcome: "aborted" });
    return "exhausted";
  }
  op.attemptCount = (op.attemptCount ?? 0) + 1;
  if (!op.canonical) op.canonical = {};
  op.canonical.retryNotBefore = new Date(now + decision.nextDelayMs).toISOString();
  op.lastFailureReason = `adapter_retry:${code}`;
  persistOpKeepingSignals(op);
  transitionOp(op, "queued", `adapter_retry:${code}`);
  const { scheduleQueuedRetry } = await import("./scheduler.js");
  scheduleQueuedRetry(op.id, op.lane as CanonicalLane, decision.nextDelayMs);
  return "retrying";
}

export function clearAdapterRetryState(op: Op): void {
  if (!op.canonical?.retryNotBefore && !op.lastFailureReason?.startsWith("adapter_retry:")) return;
  if (op.canonical) op.canonical.retryNotBefore = null;
  if (op.lastFailureReason?.startsWith("adapter_retry:")) op.lastFailureReason = undefined;
  persistOpKeepingSignals(op);
}

function safeRetryCode(code: string): string {
  return /^[a-z0-9_:-]{1,80}$/i.test(code) ? code.toLowerCase() : "adapter_unavailable";
}
