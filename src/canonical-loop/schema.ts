/**
 * Canonical-loop on-disk paths (Issue 01).
 *
 * This codebase persists ops on the filesystem (see ops/event-log.ts and
 * ops/op-store.ts). The PRD §9 "tables" map onto the per-op dir like so:
 *
 *   ~/.lax/operations/<opId>/
 *     operation.json           ← legacy Op (existing)
 *     events.jsonl             ← legacy event log (existing)
 *     checkpoint.json          ← legacy checkpoint (existing)
 *     canonical-events.jsonl   ← op_events (PRD §12) — append-only
 *     op-turns/<turn_idx>.json ← op_turns (PRD §11) — append-only
 *     op-messages.jsonl        ← op_messages (PRD §9) — append-only
 *
 * Snake-case ↔ camelCase mapping for the PRD's `ops` additive columns:
 *   lease_owner            → canonical.leaseOwner
 *   lease_expires_at       → canonical.leaseExpiresAt
 *   pause_requested_at     → canonical.pauseRequestedAt
 *   cancel_requested_at    → canonical.cancelRequestedAt
 *   redirect_instruction   → canonical.redirectInstruction
 *   redirect_received_at   → canonical.redirectReceivedAt
 *   current_turn_idx       → canonical.currentTurnIdx
 *   current_checkpoint_id  → canonical.currentCheckpointId
 *   canonical_flag_value   → canonical.flagValue
 *   session_id             → canonical.sessionId
 *   state                  → canonical.state
 */
import { join } from "node:path";
import { opDir } from "../ops/event-log.js";

export const CANONICAL_EVENTS_FILE = "canonical-events.jsonl";
export const OP_TURNS_DIR = "op-turns";
export const OP_MESSAGES_FILE = "op-messages.jsonl";

export function canonicalEventsPath(opId: string): string {
  return join(opDir(opId), CANONICAL_EVENTS_FILE);
}

export function opTurnsDir(opId: string): string {
  return join(opDir(opId), OP_TURNS_DIR);
}

export function opTurnPath(opId: string, turnIdx: number): string {
  return join(opTurnsDir(opId), `${turnIdx}.json`);
}

export function opMessagesPath(opId: string): string {
  return join(opDir(opId), OP_MESSAGES_FILE);
}
