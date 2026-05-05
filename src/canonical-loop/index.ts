/**
 * canonical-loop — module entry point (Issue 01 skeleton).
 *
 * Issue 01 lands `canonicalLoopEntry(op)` as a stub: it captures the flag
 * value on the op, transitions the op into canonical-state `queued`,
 * persists the op, and emits exactly one `state_changed` canonical event.
 * It does NOT yet drive turns — that is Issue 03.
 *
 * Hard rules from the PRD that already apply at this skeleton stage:
 *   - Only canonical-loop writes to canonical-events.jsonl.
 *   - Only canonical-loop writes `op.canonical.state`.
 *   - Adapter / worker / public-control-API code never writes here.
 */
import type { Op } from "../workers/types.js";
import { writeOp } from "../workers/op-store.js";
import { appendCanonicalEvent } from "./store.js";
import type { StateChangedBody } from "./types.js";

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
} from "./types.js";

/**
 * Skeleton entry point invoked by `op_submit_async` when the canonical
 * feature flag is ON for the op's lane.
 *
 * Mutates the input `op`:
 *   - sets `op.canonical.flagValue = true`
 *   - sets `op.canonical.state = "queued"`
 *   - sets `op.canonical.sessionId` if provided
 *
 * Persists:
 *   - operation.json via writeOp (so op_status/listOps see the canonical op)
 *   - exactly one `state_changed` event in canonical-events.jsonl with
 *     body `{ from: null, to: "queued", reason: "submitted" }`
 *
 * Returns the persisted state-changed event for caller convenience.
 *
 * NOTE: real loop execution lands in Issue 03. With this stub, an op
 * submitted under flag ON sits in `queued` and never advances — that is
 * the intended skeleton behavior for v1 canary opt-in.
 */
export function canonicalLoopEntry(op: Op, opts: { sessionId?: string } = {}): void {
  if (!op.canonical) op.canonical = {};
  op.canonical.flagValue = true;
  op.canonical.state = "queued";
  if (opts.sessionId) op.canonical.sessionId = opts.sessionId;
  // Leave lease/redirect/pause/cancel columns explicitly null so the row
  // shape on disk matches PRD §9 expectations from Issue 01 onward.
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
  appendCanonicalEvent(op.id, "state_changed", body);
}
