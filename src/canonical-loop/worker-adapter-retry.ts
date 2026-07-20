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
  const failover = await attemptRuntimeFailover(op, code, message).catch(() => ({ kind: "ineligible" } as const));
  if (failover.kind !== "ineligible") {
    const reason = failover.kind === "switched" ? "runtime_failover" : "runtime_failover_waiting";
    emit(op.id, "error", {
      code: reason,
      message: failover.kind === "switched"
        ? "The unavailable runtime was replaced by an eligible configured runtime. Resuming from the durable checkpoint."
        : "No eligible configured runtime is currently available. The operation will keep waiting and resume automatically.",
      retryable: true,
    });
    transitionOp(op, "queued", `${reason}:${code}`);
    const { scheduleQueuedRetry } = await import("./scheduler.js");
    scheduleQueuedRetry(op.id, op.lane as CanonicalLane, failover.delayMs);
    return "retrying";
  }
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
