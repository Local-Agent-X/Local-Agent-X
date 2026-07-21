import { decideRecovery } from "../ops/heartbeat.js";
import { readOp } from "../ops/op-store.js";
import { emit } from "./event-emitter.js";
import { persistOpKeepingSignals } from "./op-persist.js";
import { transitionOp } from "./state-machine.js";

export type ExecutionLaunchRecovery =
  | { kind: "retry"; delayMs: number }
  | { kind: "terminal" }
  | { kind: "owned" };

/** Reconcile a backend rejection only when durable worker ownership never
 * began. Running and terminal operations belong to the canonical worker. */
export function recoverRejectedExecutionLaunch(
  opId: string,
  allowRetry = true,
): ExecutionLaunchRecovery {
  const op = readOp(opId);
  if (!op || op.canonical?.state !== "queued") return { kind: "owned" };
  const decision = allowRetry ? decideRecovery(op, {
    committingCallsAlreadyMade: false,
    reason: "execution_launch",
  }) : { shouldRetry: false, reason: "adapter factory failed", nextDelayMs: 0 };
  op.lastFailureAt = new Date().toISOString();
  if (!decision.shouldRetry) {
    if (op.canonical) op.canonical.retryNotBefore = null;
    op.lastFailureReason = allowRetry ? "execution_launch_exhausted" : "adapter_factory_failed";
    persistOpKeepingSignals(op);
    emit(op.id, "error", {
      code: allowRetry ? "execution_launch_exhausted" : "adapter_factory_failed",
      message: "The execution worker could not take durable ownership.",
      retryable: false,
    });
    transitionOp(op, "failed", allowRetry ? "execution_launch_exhausted" : "adapter_factory_failed");
    return { kind: "terminal" };
  }
  op.attemptCount = (op.attemptCount ?? 0) + 1;
  if (!op.canonical) op.canonical = {};
  op.canonical.retryNotBefore = new Date(Date.now() + decision.nextDelayMs).toISOString();
  op.lastFailureReason = "execution_launch_retry";
  persistOpKeepingSignals(op);
  emit(op.id, "error", {
    code: "execution_launch_retry",
    message: "The execution worker did not take ownership. Retrying from the durable queue.",
    retryable: true,
  });
  return { kind: "retry", delayMs: decision.nextDelayMs };
}
