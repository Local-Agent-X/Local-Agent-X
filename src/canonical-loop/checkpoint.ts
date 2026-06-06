/**
 * Atomic post-turn checkpoint commit (PRD §11).
 *
 * One commitTurn call performs the post-turn boundary work:
 *   1. Append op_messages rows for every finalized message (assistant +
 *      tool_result), assigning a contiguous seqInTurn.
 *   2. Emit `message_appended` for each persisted message.
 *   3. Insert the op_turns row (idempotent on PK `(op_id, turn_idx)` —
 *      replay safety per PRD §11 "Idempotency").
 *   4. Update `ops.current_turn_idx` and `ops.current_checkpoint_id` and
 *      persist the op via writeOp.
 *   5. Emit `turn_committed`.
 *   6. If terminal, transition state via state-machine (which emits the
 *      paired `state_changed` event).
 *
 * v1 lives on the filesystem so true SQL-style atomicity is best-effort —
 * each underlying write is an atomic tmp+rename or append, and the order
 * above is the recoverable order: a crash mid-commit leaves the loop with
 * either no checkpoint (re-driven from prior provider_state) or a fully
 * persisted checkpoint (op_turns row present).
 */
import { randomUUID } from "node:crypto";
import { insertOpTurn, appendOpMessage, readOpMessages, readOpTurn } from "./store.js";
import { emit } from "./event-emitter.js";
import { transitionOp } from "./state-machine.js";
import { persistOpKeepingSignals } from "./op-persist.js";
import { readOp } from "../ops/op-store.js";
import { getSessionForOp } from "../ops/session-bridge.js";
import { appendActionLedger } from "../ops/action-ledger.js";
import type { Op } from "../ops/types.js";
import type {
  CanonicalMessageRole,
  OpMessageRow,
  OpTurnRow,
  ProviderStateEnvelope,
  ToolCallSummary,
} from "./types.js";

export interface CommitTurnMessage {
  /** Stable id from the adapter when it finalized the message; auto-generated otherwise. */
  messageId?: string;
  role: CanonicalMessageRole;
  content: unknown;
}

export interface CommitTurnInput {
  op: Op;
  turnIdx: number;
  providerState: ProviderStateEnvelope;
  messages: CommitTurnMessage[];
  toolCallSummary: ToolCallSummary[];
  terminalReason: "done" | "error" | null;
  /** True if a `pending_redirect` was folded into this turn's prompt. */
  redirectConsumed?: boolean;
  /**
   * The instructionId folded into this turn's prompt. Used to:
   *   - Emit `redirect_applied` with the same id that `redirect_received`
   *     announced (PRD §12 / acceptance #5).
   *   - Compare against the disk column so a newer redirect that landed
   *     mid-turn is preserved for the next turn (latest-wins semantics).
   */
  redirectInstructionId?: string;
  /** Wall-clock ms inside `adapter.runTurn`. Recorded for soak telemetry. */
  modelMs?: number;
  /** Wall-clock ms inside `dispatchTools`. Recorded for soak telemetry. */
  toolDispatchMs?: number;
}

export interface CommitTurnOutput {
  turn: OpTurnRow;
  messages: OpMessageRow[];
  /** False if the op_turns row was already present (replay path). */
  inserted: boolean;
}

export function commitTurn(input: CommitTurnInput): CommitTurnOutput {
  const { op, turnIdx } = input;

  // Idempotent guard (PRD §11 + acceptance #8). If `(op_id, turn_idx)`
  // already has an op_turns row, this is a replay path: a prior worker
  // committed the turn, then died (or the transaction ack was lost) before
  // its in-memory state advanced. Treat as already-committed — skip
  // message appends, skip event emission, skip state transitions. The
  // caller advances to `turnIdx + 1`.
  const existing = readOpTurn(op.id, turnIdx);
  if (existing) {
    if (!op.canonical) op.canonical = {};
    op.canonical.currentTurnIdx = Math.max(op.canonical.currentTurnIdx ?? -1, turnIdx);
    op.canonical.currentCheckpointId = `${op.id}#${turnIdx}`;
    persistOpKeepingSignals(op);
    return { turn: existing, messages: [], inserted: false };
  }

  const persistedMsgs: OpMessageRow[] = [];

  // Offset seqInTurn past any pre-existing rows for this turn (e.g. the
  // turn-0 user seed appended by seedInitialUserMessage). Keeps
  // (op_id, turn_idx, seq_in_turn) unique across input + output messages.
  const seqBase = readOpMessages(op.id).filter(m => m.turnIdx === turnIdx).length;

  for (let i = 0; i < input.messages.length; i++) {
    const m = input.messages[i];
    const row: OpMessageRow = {
      messageId: m.messageId ?? `msg-${randomUUID()}`,
      opId: op.id,
      turnIdx,
      seqInTurn: seqBase + i,
      role: m.role,
      content: m.content,
      createdAt: new Date().toISOString(),
    };
    appendOpMessage(row);
    persistedMsgs.push(row);
    emit(op.id, "message_appended", {
      turnIdx,
      role: row.role,
      messageId: row.messageId,
    });
  }

  const redirectConsumed = input.redirectConsumed === true;

  const turnRow: OpTurnRow = {
    opId: op.id,
    turnIdx,
    providerState: input.providerState,
    toolCallSummary: input.toolCallSummary,
    terminalReason: input.terminalReason,
    redirectConsumed,
    createdAt: new Date().toISOString(),
    ...(input.modelMs !== undefined ? { modelMs: input.modelMs } : {}),
    ...(input.toolDispatchMs !== undefined ? { toolDispatchMs: input.toolDispatchMs } : {}),
  };
  const inserted = insertOpTurn(turnRow);

  if (!op.canonical) op.canonical = {};
  op.canonical.currentTurnIdx = turnIdx;
  op.canonical.currentCheckpointId = `${op.id}#${turnIdx}`;

  // Decide whether to clear the redirect column on disk.
  // - We only clear it if THIS turn applied the same instructionId that's
  //   currently on disk. If a newer opRedirect landed mid-turn, its
  //   instructionId now sits on disk and must survive for the next turn
  //   (latest-wins, but the "previous" instruction was already consumed).
  // - In the survives-mid-turn-overwrite case we still emit redirect_applied
  //   for the instruction we DID apply this turn — exactly one
  //   redirect_applied per consumed redirect (PRD §12).
  const appliedId = redirectConsumed ? input.redirectInstructionId : undefined;
  const clearRedirect = appliedId != null && diskRedirectMatches(op.id, appliedId);
  // Preserve control-API signal columns (pause/cancel/redirect) from disk
  // so a turn commit landing concurrently with opPause does not clobber
  // the signal the worker is about to read at the next turn boundary.
  // When `clearRedirect` is true, the redirect column is intentionally
  // dropped (overrides the on-disk preservation).
  if (clearRedirect) {
    op.canonical.redirectInstruction = null;
    op.canonical.redirectReceivedAt = null;
  }
  persistOpKeepingSignals(op, { clearRedirect });

  emit(op.id, "turn_committed", {
    turnIdx,
    messageCount: persistedMsgs.length,
    toolCount: input.toolCallSummary.length,
    tools: input.toolCallSummary.map((t) => ({ tool: t.tool, status: t.resultStatus })),
  });

  // Operational action ledger — the one write site. Denormalizes this turn's
  // {tool, status} summary into a session-keyed log so the agent can recall
  // what it did across messages once the op completes (op_turns is per-op and
  // the session→op map drops finished ops). Tool-less turns are skipped inside
  // appendActionLedger. Best-effort; never blocks the commit.
  appendActionLedger({
    ts: turnRow.createdAt,
    sessionId: getSessionForOp(op.id) ?? "",
    opId: op.id,
    opType: op.type,
    turnIdx,
    task: op.task,
    actions: input.toolCallSummary.map((t) => ({ tool: t.tool, status: t.resultStatus })),
    terminalReason: input.terminalReason,
  });

  if (redirectConsumed && appliedId != null) {
    emit(op.id, "redirect_applied", { turnIdx, instructionId: appliedId });
  }

  if (input.terminalReason === "done") {
    transitionOp(op, "succeeded", "turn_done");
  } else if (input.terminalReason === "error") {
    transitionOp(op, "failed", "turn_error");
  }

  return { turn: turnRow, messages: persistedMsgs, inserted };
}

function diskRedirectMatches(opId: string, instructionId: string): boolean {
  const fresh = readOp(opId);
  return fresh?.canonical?.redirectInstruction?.instructionId === instructionId;
}
