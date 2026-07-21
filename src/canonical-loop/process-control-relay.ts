import { getApprovalManager } from "../approval-manager.js";
import { readOp } from "../ops/op-store.js";
import { publishSignal } from "./signals.js";

/** Mirror durable controls into the child process's in-memory subscribers.
 * Durable op columns remain authoritative across parent/child restarts. */
export function startProcessControlRelay(opId: string, intervalMs = 100): () => void {
  let cancelSeen: string | null = null;
  let approvalSeen: string | null = null;
  const poll = () => {
    const op = readOp(opId);
    const cancelAt = op?.canonical?.cancelRequestedAt ?? null;
    if (cancelAt && cancelAt !== cancelSeen) {
      cancelSeen = cancelAt;
      publishSignal({ kind: "cancel", opId, actor: "process-control", ts: cancelAt });
    }
    const pending = op?.canonical?.pendingApproval;
    if (pending?.resolution && pending.approvalId !== approvalSeen) {
      if (getApprovalManager().resolveApproval(pending.approvalId, pending.resolution.approved)) {
        approvalSeen = pending.approvalId;
      }
    }
  };
  poll();
  const timer = setInterval(poll, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
