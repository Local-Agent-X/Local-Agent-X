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
import { writeOp } from "../workers/op-store.js";
import { insertOpTurn, appendOpMessage } from "./store.js";
import { emit } from "./event-emitter.js";
import { transitionOp } from "./state-machine.js";
import type { Op } from "../workers/types.js";
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
  redirectConsumed?: boolean;
}

export interface CommitTurnOutput {
  turn: OpTurnRow;
  messages: OpMessageRow[];
  /** False if the op_turns row was already present (replay path). */
  inserted: boolean;
}

export function commitTurn(input: CommitTurnInput): CommitTurnOutput {
  const { op, turnIdx } = input;
  const persistedMsgs: OpMessageRow[] = [];

  for (let i = 0; i < input.messages.length; i++) {
    const m = input.messages[i];
    const row: OpMessageRow = {
      messageId: m.messageId ?? `msg-${randomUUID()}`,
      opId: op.id,
      turnIdx,
      seqInTurn: i,
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

  const turnRow: OpTurnRow = {
    opId: op.id,
    turnIdx,
    providerState: input.providerState,
    toolCallSummary: input.toolCallSummary,
    terminalReason: input.terminalReason,
    redirectConsumed: input.redirectConsumed ?? false,
    createdAt: new Date().toISOString(),
  };
  const inserted = insertOpTurn(turnRow);

  if (!op.canonical) op.canonical = {};
  op.canonical.currentTurnIdx = turnIdx;
  op.canonical.currentCheckpointId = `${op.id}#${turnIdx}`;
  writeOp(op);

  emit(op.id, "turn_committed", {
    turnIdx,
    messageCount: persistedMsgs.length,
    toolCount: input.toolCallSummary.length,
  });

  if (input.terminalReason === "done") {
    transitionOp(op, "succeeded", "turn_done");
  } else if (input.terminalReason === "error") {
    transitionOp(op, "failed", "turn_error");
  }

  return { turn: turnRow, messages: persistedMsgs, inserted };
}
