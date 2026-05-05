/**
 * Canonical-loop v1 types — Issue 01 skeleton.
 *
 * Mirrors PRD §5 glossary and §9 schema. Field names are camelCase in TS;
 * the equivalent snake_case "column" names from the PRD are listed in
 * schema.ts. Everything in this file is additive — no legacy types change.
 */
import type { OpLane } from "../workers/types.js";

// ── Canonical state machine (PRD §10) ─────────────────────────────────────

export type CanonicalState =
  | "queued"
  | "running"
  | "paused"
  | "cancelling"
  | "cancelled"
  | "succeeded"
  | "failed";

export const TERMINAL_CANONICAL_STATES: readonly CanonicalState[] = [
  "succeeded",
  "failed",
  "cancelled",
] as const;

// ── Canonical lane (PRD §14) ──────────────────────────────────────────────
// `OpLane` from workers/types.ts is the legacy 3-value enum. Issue 14 adds
// `"ide"` to OpLane proper. For Issue 01 we accept the legacy values; the
// `"ide"` lane lands when issue 14 wires it through the submission API.
export type CanonicalLane = OpLane | "ide";

// ── Provider-state envelope (PRD §11 / §15) ───────────────────────────────

export interface ProviderStateEnvelope {
  adapterName: string;
  adapterVersion: string;
  providerPayload: unknown;
}

// ── Redirect instruction (PRD §13) ────────────────────────────────────────

export interface RedirectInstruction {
  instructionId: string;
  text: string;
  receivedAt: string;
}

// ── Additive Op fields (PRD §9 ops columns) ───────────────────────────────
// Sub-object on `Op` so legacy consumers ignore it and the canonical-loop
// has one place to read/write its own concerns.

export interface CanonicalOpFields {
  state?: CanonicalState;
  flagValue?: boolean;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  pauseRequestedAt?: string | null;
  cancelRequestedAt?: string | null;
  redirectInstruction?: RedirectInstruction | null;
  redirectReceivedAt?: string | null;
  currentTurnIdx?: number | null;
  currentCheckpointId?: string | null;
  sessionId?: string | null;
}

// ── op_turns row (PRD §11) ────────────────────────────────────────────────

export interface OpTurnRow {
  opId: string;
  turnIdx: number;
  providerState: ProviderStateEnvelope;
  toolCallSummary: ToolCallSummary[];
  terminalReason: "done" | "error" | "cancelled" | null;
  redirectConsumed: boolean;
  createdAt: string;
}

export interface ToolCallSummary {
  tool: string;
  argsHash: string;
  resultStatus: "ok" | "error" | "cancelled";
  durationMs: number;
}

// ── op_messages row (PRD §9) ──────────────────────────────────────────────

export type CanonicalMessageRole =
  | "system"
  | "user"
  | "assistant"
  | "tool_result"
  | "control";

export interface OpMessageRow {
  messageId: string;
  opId: string;
  turnIdx: number;
  seqInTurn: number;
  role: CanonicalMessageRole;
  content: unknown;
  createdAt: string;
}

// ── op_events row (PRD §12) ───────────────────────────────────────────────
// Locked v1 event-type enum.

export type CanonicalEventType =
  | "state_changed"
  | "turn_started"
  | "turn_committed"
  | "tool_started"
  | "tool_finished"
  | "message_appended"
  | "redirect_received"
  | "redirect_applied"
  | "pause_requested"
  | "resume_requested"
  | "cancel_requested"
  | "lease_acquired"
  | "lease_lost"
  | "error";

export interface CanonicalEvent {
  opId: string;
  seq: number;
  type: CanonicalEventType;
  ts: string;
  body: Record<string, unknown> | null;
}

// ── State-changed event body shape ────────────────────────────────────────

export interface StateChangedBody extends Record<string, unknown> {
  from: CanonicalState | null;
  to: CanonicalState;
  reason: string;
}
