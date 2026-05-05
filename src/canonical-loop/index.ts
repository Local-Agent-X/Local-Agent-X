/**
 * canonical-loop — module entry point.
 *
 * Issue 01 landed `canonicalLoopEntry(op)` as a stub that captured the flag
 * value, persisted the op into canonical state `queued`, and emitted the
 * opening `state_changed` event.
 *
 * Issue 03 lights up the loop: when an adapter factory has been registered
 * for the op (per-op or per-lane via runtime.ts), the entry also enqueues
 * the op and kicks the scheduler. The scheduler grants an in-process lease
 * to a worker, which drives the turn_loop until terminal and releases.
 *
 * Hard rules from the PRD that already apply:
 *   - Only canonical-loop writes canonical-events.jsonl.
 *   - Only canonical-loop writes `op.canonical.state` (via state-machine).
 *   - Adapters / public control APIs / workers from outside this module
 *     never write canonical state directly.
 */
import type { Op } from "../workers/types.js";
import { writeOp } from "../workers/op-store.js";
import { emit } from "./event-emitter.js";
import { resolveAdapterFactory } from "./runtime.js";
import { enqueueOp, pumpScheduler } from "./scheduler.js";
import type { CanonicalLane, StateChangedBody } from "./types.js";

export {
  isCanonicalLoopEnabled,
  envVarForLane,
} from "./feature-flag.js";

export { decideSubmitRouting, type SubmitRouting } from "./router.js";

export {
  appendCanonicalEvent,
  readCanonicalEvents,
  readCanonicalEventsSince,
  nextEventSeq,
  insertOpTurn,
  readLatestOpTurn,
  readOpTurn,
  appendOpMessage,
  readOpMessages,
} from "./store.js";

export {
  canonicalEventsPath,
  opTurnsDir,
  opTurnPath,
  opMessagesPath,
} from "./schema.js";

export type {
  CanonicalState,
  CanonicalLane,
  CanonicalEvent,
  CanonicalEventType,
  CanonicalOpFields,
  OpTurnRow,
  OpMessageRow,
  ProviderStateEnvelope,
  RedirectInstruction,
  StateChangedBody,
  ToolCallSummary,
} from "./types.js";

// ── Issue 03 runtime surface ──────────────────────────────────────────────

export {
  registerAdapterForOp,
  setDefaultAdapterForLane,
  setToolDispatcher,
  getToolDispatcher,
  resolveAdapterFactory,
  resetCanonicalRuntime,
  type AdapterFactory,
} from "./runtime.js";

export {
  enqueueOp,
  pumpScheduler,
  awaitIdle,
  resetScheduler,
  schedulerSnapshot,
} from "./scheduler.js";

export {
  type ToolDispatcher,
  type ToolDispatchResult,
  NotConfiguredToolDispatcher,
  functionToolDispatcher,
} from "./tool-dispatch.js";

export {
  getBus,
  setBus,
  resetBus,
  streamChannel,
  eventsChannel,
  type CanonicalBus,
  type BusListener,
} from "./bus.js";

export {
  emit as emitCanonicalEvent,
  publishStreamChunk,
} from "./event-emitter.js";

export { runWorker, type WorkerHandle } from "./worker.js";
export { driveTurn, type DriveTurnResult } from "./turn-loop.js";
export { commitTurn, type CommitTurnInput, type CommitTurnOutput, type CommitTurnMessage } from "./checkpoint.js";
export {
  transitionOp,
  isTerminalCanonicalState,
  IllegalTransitionError,
} from "./state-machine.js";

/**
 * Entry point invoked by `op_submit_async` when the canonical feature flag
 * is ON for the op's lane. Synchronous bookkeeping; loop driving is
 * fire-and-forget via the scheduler.
 *
 * Behavior:
 *   - Mutates `op` to set `canonical.flagValue=true`, `canonical.state="queued"`,
 *     and the additive PRD §9 columns to their initial values (mostly null).
 *   - Persists the op via writeOp.
 *   - Emits exactly one `state_changed` event with body
 *     `{ from: null, to: "queued", reason: "submitted" }`.
 *   - If an adapter factory has been registered for this op (per-op or
 *     per-lane via `registerAdapterForOp` / `setDefaultAdapterForLane`), the
 *     entry also enqueues the op and kicks the scheduler. With no adapter
 *     registered, the op stays at `queued` — the same skeleton behavior as
 *     Issue 01, used by tests that don't drive a loop.
 *
 * NOTE: signature unchanged from Issue 01 — `op_submit_async` consumers see
 * the same return shape regardless of routing (PRD §17 hard rule).
 */
export function canonicalLoopEntry(op: Op, opts: { sessionId?: string } = {}): void {
  if (!op.canonical) op.canonical = {};
  op.canonical.flagValue = true;
  op.canonical.state = "queued";
  if (opts.sessionId) op.canonical.sessionId = opts.sessionId;
  if (op.canonical.leaseOwner === undefined) op.canonical.leaseOwner = null;
  if (op.canonical.leaseExpiresAt === undefined) op.canonical.leaseExpiresAt = null;
  if (op.canonical.pauseRequestedAt === undefined) op.canonical.pauseRequestedAt = null;
  if (op.canonical.cancelRequestedAt === undefined) op.canonical.cancelRequestedAt = null;
  if (op.canonical.redirectInstruction === undefined) op.canonical.redirectInstruction = null;
  if (op.canonical.redirectReceivedAt === undefined) op.canonical.redirectReceivedAt = null;
  if (op.canonical.currentTurnIdx === undefined) op.canonical.currentTurnIdx = null;
  if (op.canonical.currentCheckpointId === undefined) op.canonical.currentCheckpointId = null;

  writeOp(op);

  const body: StateChangedBody = { from: null, to: "queued", reason: "submitted" };
  emit(op.id, "state_changed", body);

  // Issue 03: if there's an adapter to drive this op, schedule it. Otherwise
  // leave it queued (tests / canary opt-in that didn't register an adapter).
  if (resolveAdapterFactory(op)) {
    enqueueOp(op.id, op.lane as CanonicalLane);
    pumpScheduler();
  }
}
