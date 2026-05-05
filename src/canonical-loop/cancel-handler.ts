/**
 * Cancel-handling primitives for the canonical-loop worker (Issue 06).
 *
 * `opCancel` is the public-control entrypoint (see control-api.ts); this
 * module ships the worker-side primitives that react to a CancelSignal:
 *
 *   - startCancelTracker(op, adapter)
 *       Subscribe to op_signals:{opId}. On a CancelSignal:
 *         * flip tracker.cancelled = true
 *         * transitionOp(running → cancelling) IMMEDIATELY (PRD §13: do not
 *           wait for adapter.abort() to resolve)
 *         * call adapter.abort() with a 1s race timeout (PRD acceptance #2)
 *       The tracker is consumed by the worker; driveTurn checks
 *       `tracker.cancelled` to skip the post-turn commit.
 *
 *   - finalizeCancel(op, tracker)
 *       Await abort/timeout, clear cancel_requested_at, transition
 *       cancelling → cancelled. Idempotent on already-cancelled ops.
 *
 *   - applyPreLeaseCancel(op)
 *       Used before the worker leases the op. If cancel_requested_at is
 *       set, transition queued → cancelled directly (no running, no
 *       lease_acquired) and clear the signal. Returns true if cancelled.
 *
 *   - applyBoundaryCancel(op, adapter)
 *       Defensive path: a cancel column was set but the bus signal
 *       subscription missed it (rare). Performs the full
 *       running → cancelling → cancelled flow with adapter.abort() at the
 *       turn boundary.
 *
 * Cancel beats pause beats redirect (PRD §13). Callers enforce the
 * precedence; this module just performs cancel work.
 */
import { readOp, writeOp } from "../workers/op-store.js";
import { transitionOp, IllegalTransitionError } from "./state-machine.js";
import { subscribeOpSignals } from "./signals.js";
import type { Op } from "../workers/types.js";
import type { Adapter } from "./adapter-contract.js";

const ABORT_TIMEOUT_MS = 1_000;

export interface CancelTracker {
  cancelled: boolean;
  abortDone: Promise<void> | null;
  off: () => void;
}

export function startCancelTracker(op: Op, adapter: Adapter): CancelTracker {
  const tracker: CancelTracker = { cancelled: false, abortDone: null, off: () => { /* no-op */ } };
  tracker.off = subscribeOpSignals(op.id, (s) => {
    if (s.kind !== "cancel" || tracker.cancelled) return;
    tracker.cancelled = true;
    // Transition to cancelling immediately on signal receipt — PRD §13
    // says cancel is mid-stream and not deferred to a turn boundary.
    safeTransition(op, "cancelling", "cancel_requested");
    tracker.abortDone = abortWithTimeout(adapter);
  });
  return tracker;
}

export async function finalizeCancel(op: Op, tracker: CancelTracker): Promise<void> {
  if (tracker.abortDone) {
    try { await tracker.abortDone; } catch { /* swallow */ }
  }
  // Refresh the in-memory op from disk so we observe the cancelling state
  // written by the signal handler.
  const fresh = readOp(op.id);
  if (fresh?.canonical) op.canonical = fresh.canonical;
  if (op.canonical?.state !== "cancelling") return;
  // Clear cancel_requested_at on disk first so the persistOpKeepingSignals
  // merge inside transitionOp does not resurrect it.
  if (!op.canonical) op.canonical = {};
  op.canonical.cancelRequestedAt = null;
  writeOp(op);
  safeTransition(op, "cancelled", "adapter_aborted");
}

export function applyPreLeaseCancel(op: Op): boolean {
  const fresh = readOp(op.id);
  if (!fresh?.canonical?.cancelRequestedAt) return false;
  if (fresh.canonical) op.canonical = fresh.canonical;
  if (!op.canonical) op.canonical = {};
  op.canonical.cancelRequestedAt = null;
  writeOp(op);
  safeTransition(op, "cancelled", "cancel_before_lease");
  return true;
}

export async function applyBoundaryCancel(op: Op, adapter: Adapter): Promise<void> {
  const fresh = readOp(op.id);
  if (fresh?.canonical) op.canonical = fresh.canonical;
  if (!op.canonical) op.canonical = {};
  op.canonical.cancelRequestedAt = null;
  writeOp(op);
  safeTransition(op, "cancelling", "cancel_requested");
  await abortWithTimeout(adapter);
  safeTransition(op, "cancelled", "adapter_aborted");
}

// ── internals ────────────────────────────────────────────────────────────

async function abortWithTimeout(adapter: Adapter): Promise<void> {
  const abortP = adapter.abort().catch(() => undefined);
  const timeoutP = new Promise<void>((resolve) => setTimeout(resolve, ABORT_TIMEOUT_MS));
  await Promise.race([abortP, timeoutP]);
}

function safeTransition(op: Op, to: Parameters<typeof transitionOp>[1], reason: string): void {
  try {
    transitionOp(op, to, reason);
  } catch (e) {
    if (e instanceof IllegalTransitionError) return; // op already moved past — silent no-op.
    throw e;
  }
}
