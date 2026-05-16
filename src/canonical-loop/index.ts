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
import { transitionOp } from "./state-machine.js";
import { readCanonicalEvents as readCanonicalEventsInternal } from "./store.js";
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
  readOpTurns,
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
  registerToolDispatcherForOp,
  unregisterToolDispatcherForOp,
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

// ── Issue 04 public control API surface ───────────────────────────────────

export {
  opEventsSince,
  subscribeOpEvents,
  subscribeOpStream,
  reconnectOp,
  OP_EVENTS_FROM_BEGINNING,
  type OpEventsSinceResult,
  type OpEventsSinceOk,
  type OpEventsSinceErr,
  type ReconnectResult,
  type ReconnectOk,
  type ReconnectErr,
  type CanonicalEventListener,
  type StreamChunkListener,
} from "./control-api.js";

// ── Issue 05 public control API surface (pause / resume) ──────────────────

export {
  opPause,
  opResume,
  type ControlResult,
  type ControlOk,
  type ControlErr,
} from "./control-api.js";

export {
  signalChannel,
  publishSignal,
  subscribeOpSignals,
  type CanonicalSignal,
  type CanonicalSignalKind,
  type PauseSignal,
  type ResumeSignal,
  type CancelSignal,
  type SignalListener,
} from "./signals.js";

// ── Issue 06 public control API surface (cancel mid-stream) ───────────────

export { opCancel } from "./control-api.js";

// ── Issue 07 public control API surface (redirect, latest-wins) ───────────

export {
  opRedirect,
  type RedirectControlResult,
  type RedirectControlErr,
} from "./control-api.js";

export { type RedirectSignal } from "./signals.js";

// ── Issue 08 lease + crash-recovery surface ───────────────────────────────

export {
  acquireLease,
  heartbeatLease,
  releaseLease,
  isLeaseExpired,
  getLeaseConfig,
  setLeaseConfig,
  resetLeaseConfig,
  type LeaseConfig,
} from "./lease.js";

export {
  recoverStaleOp,
  recoverStaleOps,
  sweepStaleCanonicalOps,
  type RecoveryOutcome,
  type RecoveryOutcomeKind,
} from "./recovery.js";

export { evictWorker } from "./scheduler.js";

// Test-only crash simulation primitive: stops a worker's heartbeat
// without releasing its lease. Lease will expire on its own and
// `recoverStaleOp` can then recover it. Underscore marks it internal.
export { _pauseHeartbeat } from "./worker.js";

// ── Issue 09 Anthropic adapter ────────────────────────────────────────────

export {
  AnthropicAdapter,
  createAnthropicAdapter,
  ANTHROPIC_ADAPTER_NAME,
  ANTHROPIC_ADAPTER_VERSION,
  PROVIDER_STATE_MAX_BYTES_DEFAULT,
  type AnthropicAdapterOptions,
  type AnthropicTransport,
  type AnthropicTransportRequest,
  type TransportEvent,
  type TransportMessage,
  type TransportTool,
} from "./adapters/anthropic.js";

// ── Issue 11 Codex adapter (v1.1 canary) ────────────────────────────────────

export {
  CodexAdapter,
  createCodexAdapter,
  CODEX_ADAPTER_NAME,
  CODEX_ADAPTER_VERSION,
  type CodexAdapterOptions,
} from "./adapters/codex.js";

export { listActiveCanonicalOps, type ActiveCanonicalOp } from "./active-ops.js";

export { awaitCanonicalOp } from "./await-op.js";

export {
  runChatViaCanonical,
  type CanonicalChatContext,
} from "./chat-runner.js";

export {
  runAgentViaCanonical,
  type CanonicalAgentOptions,
} from "./agent-runner.js";

export {
  makeChatToolDispatcher,
  type ChatToolDispatcherOptions,
} from "./chat-tool-dispatcher.js";

export { runWorker, type WorkerHandle } from "./worker.js";
export { driveTurn, type DriveTurnResult } from "./turn-loop.js";
export { seedInitialUserMessage, buildInitialUserContent } from "./initial-prompt.js";
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

  // Issue 03: if there's an adapter to drive this op, schedule it. If not,
  // we must NOT leave the op queued forever (PRD §3 lifecycle invariant).
  // Fail-fast happens on the next microtask so the synchronous bookkeeping
  // contract from Issue 01 (return-with-state="queued" + one event) is
  // preserved for callers that read on the same task.
  if (resolveAdapterFactory(op)) {
    enqueueOp(op.id, op.lane as CanonicalLane);
    pumpScheduler();
  } else {
    queueMicrotask(() => failForMissingAdapter(op));
  }
}

/**
 * Fail an op cleanly when no adapter factory is registered for its
 * lane/provider. Emits a canonical `error` event with `code: "adapter_error"`
 * and transitions queued → failed. Defensive against double-firing — if the
 * op is no longer in `queued`, this is a no-op. Also rechecks for a
 * late-registered adapter (caller registered between submit and this
 * microtask firing — common in Issue 08 recovery tests that register
 * after synthesizing state) and routes to the scheduler instead of
 * failing.
 */
function failForMissingAdapter(op: Op): void {
  if (op.canonical?.state !== "queued") return;
  // Defensive (Issue 08): if the op has progress beyond the initial submit
  // event, some other path is managing it (recovery emitted lease_lost +
  // state_changed running→queued, opPause/Cancel/Redirect ran, etc.). The
  // fail-safe was queued before any of that happened — defer to whoever
  // owns the op now. Without this guard, a recovered op would race the
  // replacement worker's launch and end up at `failed`.
  if (readCanonicalEventsInternal(op.id).length > 1) return;
  if (resolveAdapterFactory(op)) {
    enqueueOp(op.id, op.lane as CanonicalLane);
    pumpScheduler();
    return;
  }
  emit(op.id, "error", {
    code: "adapter_error",
    message: `no adapter factory registered for op ${op.id} (lane=${op.lane})`,
    retryable: false,
  });
  try {
    transitionOp(op, "failed", "adapter_not_configured");
  } catch {
    // State machine rejected — op already left queued. Leave alone.
  }
}
