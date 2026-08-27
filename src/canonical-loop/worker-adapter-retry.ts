import { decideRecovery } from "../ops/heartbeat.js";
import type { Op } from "../ops/types.js";
import { emit } from "./event-emitter.js";
import { persistOpKeepingSignals } from "./op-persist.js";
import { transitionOp } from "./state-machine.js";
import { recordTerminalOutcome } from "./turn-loop/record-outcome.js";
import type { CanonicalLane } from "./types.js";
import { attemptRuntimeFailover } from "./runtime-failover.js";

export async function handleAdapterRetry(op: Op, reportedCode: string, message = ""): Promise<"retrying" | "exhausted"> {
  const code = safeRetryCode(reportedCode);
  const failover = await attemptRuntimeFailover(op, code, message);
  if (failover.kind === "switched") {
    emit(op.id, "error", {
      code: "runtime_failover",
      message: `The unavailable runtime was replaced by ${failover.provider}/${failover.model}. Resuming from the durable checkpoint.`,
      retryable: true,
    });
    transitionOp(op, "queued", `runtime_failover:${code}`);
    const { scheduleQueuedRetry } = await import("./scheduler.js");
    scheduleQueuedRetry(op.id, op.lane as CanonicalLane, failover.delayMs);
    return "retrying";
  }
  // `committingCallsAlreadyMade` is false by CONSTRUCTION, not by assumption:
  // driveTurn only reports a retryCode when the failing turn streamed nothing,
  // finalized nothing and dispatched no tool call at all (the activity guard in
  // turn-loop/reported-adapter-recovery.ts), and the relaunch resumes at
  // `readLatestOpTurn + 1` (worker.ts), so no committed turn is ever replayed.
  // Earlier turns may well hold committed side effects — refusing the retry for
  // those would hard-fail a long op on a transient 429 without preventing any
  // double-mutate. Cross-provider replay is the case that IS unsafe, and
  // attemptRuntimeFailover above gates it on hasAmbiguousSideEffects.
  const decision = decideRecovery(op, {
    committingCallsAlreadyMade: false,
    reason: `adapter:${code}`,
  });
  const now = Date.now();
  op.lastFailureAt = new Date(now).toISOString();
  if (!decision.shouldRetry) {
    if (op.canonical) op.canonical.retryNotBefore = null;
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
  const waiting = failover.kind === "waiting";
  const delayMs = waiting ? Math.max(failover.delayMs, decision.nextDelayMs) : decision.nextDelayMs;
  op.canonical.retryNotBefore = new Date(now + delayMs).toISOString();
  op.lastFailureReason = waiting ? `runtime_failover_waiting:${code}` : `adapter_retry:${code}`;
  persistOpKeepingSignals(op);
  if (waiting) {
    emit(op.id, "error", {
      code: "runtime_failover_waiting",
      message: "No eligible configured runtime is currently available. Recovery remains bounded by the operation retry policy.",
      retryable: true,
    });
  }
  transitionOp(op, "queued", `${waiting ? "runtime_failover_waiting" : "adapter_retry"}:${code}`);
  const { scheduleQueuedRetry } = await import("./scheduler.js");
  scheduleQueuedRetry(op.id, op.lane as CanonicalLane, delayMs);
  return "retrying";
}

export function clearAdapterRetryState(op: Op): void {
  if (!op.canonical?.retryNotBefore && !op.canonical?.runtimeFailover
    && !op.lastFailureReason?.startsWith("adapter_retry:")
    && !op.lastFailureReason?.startsWith("runtime_failover")) return;
  if (op.canonical) {
    op.canonical.retryNotBefore = null;
    op.canonical.runtimeFailover = undefined;
  }
  if (op.lastFailureReason?.startsWith("adapter_retry:")
    || op.lastFailureReason?.startsWith("runtime_failover")) op.lastFailureReason = undefined;
  persistOpKeepingSignals(op);
}

function safeRetryCode(code: string): string {
  return /^[a-z0-9_:-]{1,80}$/i.test(code) ? code.toLowerCase() : "adapter_unavailable";
}
