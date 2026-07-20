/**
 * Canonical-loop v1 types — Issue 01 skeleton.
 *
 * Mirrors PRD §5 glossary and §9 schema. Field names are camelCase in TS;
 * the equivalent snake_case "column" names from the PRD are listed in
 * schema.ts. Everything in this file is additive — no legacy types change.
 */
import type { OpLane } from "../ops/types.js";
import type { ToolResultStatus } from "../types.js";

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
// `OpLane` from ops/types.ts is the legacy 3-value enum. Issue 14 adds
// `"ide"` to OpLane proper. For Issue 01 we accept the legacy values; the
// `"ide"` lane lands when issue 14 wires it through the submission API.
export type CanonicalLane = OpLane | "ide";

// ── Provider-state envelope (PRD §11 / §15) ───────────────────────────────

export interface ProviderStateEnvelope {
  adapterName: string;
  adapterVersion: string;
  providerPayload: unknown;
  /**
   * True when the message view SENT for this turn's request was ephemerally
   * compacted (compact-history.ts). Compaction never persists to op_messages,
   * so this turn's recorded usage reflects the compacted view — NOT the full
   * replay the next turn rebuilds. lastTurnUsage (op-usage.ts) refuses to
   * anchor context sizing on such a turn. Stamped by turn-loop at commit as
   * an EXPLICIT boolean on EVERY committed turn, never by adapters; persisted
   * with the op_turn row so resumed ops keep the refusal across a process
   * restart. Absence is therefore an era marker: the row predates reliable
   * recording (pre-stamp compactions, pre-2026-06-26 observedTools gaps) and
   * is refused as an anchor too.
   */
  viewCompacted?: boolean;
}

// ── Redirect instruction (PRD §13) ────────────────────────────────────────

export interface RedirectInstruction {
  instructionId: string;
  text: string;
  receivedAt: string;
}

// ── Pending approval (durable signal column) ──────────────────────────────

/**
 * Durable record of an approval card the op is blocked on. Written by the
 * approval manager when an op-scoped "ask" goes out, cleared when the card
 * settles (approve / deny / timeout / superseded / session teardown) or when
 * `opResolveApproval` records a decision for a no-longer-live card
 * (post-restart). The in-process ApprovalManager promise remains the ONLY
 * delivery mechanism — this column is the durable shadow that survives a
 * crash so recovery's re-drive re-ask (recovery.ts) has the prior context.
 * Timeout stays in-process; `requestedAt` (epoch ms) lets a future reader
 * compute expiry without a timer.
 */
export interface PendingApprovalRecord {
  approvalId: string;
  toolName: string;
  toolCallId?: string;
  argsPreview: string;
  context?: string;
  requestedAt: number;
  /**
   * Decision recorded while NO in-process card was live (post-restart
   * opResolveApproval). The column is kept — not cleared — so recovery's
   * re-ask reconciliation (approval-manager) can APPLY the decision to the
   * matching re-ask instead of re-prompting; consumption clears the column.
   * An expired never-consumed resolution is settled as timeout by the
   * recovery hygiene sweep. A card with a resolution is not answerable and
   * must not be surfaced by rediscovery APIs.
   */
  resolution?: { approved: boolean; resolvedAt: number };
}

// ── Additive Op fields (PRD §9 ops columns) ───────────────────────────────
// Sub-object on `Op` so legacy consumers ignore it and the canonical-loop
// has one place to read/write its own concerns.

export interface CanonicalOpFields {
  state?: CanonicalState;
  flagValue?: boolean;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  /** Monotonic fencing identity. Release clears ownership but never this value. */
  leaseGeneration?: number;
  pauseRequestedAt?: string | null;
  cancelRequestedAt?: string | null;
  redirectInstruction?: RedirectInstruction | null;
  redirectReceivedAt?: string | null;
  /** Bounded durable dedupe keys for transport-originated redirects. */
  redirectIngressKeys?: string[];
  pendingApproval?: PendingApprovalRecord | null;
  currentTurnIdx?: number | null;
  currentCheckpointId?: string | null;
  sessionId?: string | null;
  suspension?: {
    reason: "blocked" | "stalled" | "interrupted" | "user-paused";
    detail: string;
    suspendedAt: string;
  } | null;
  /** Durable backoff gate for a retryable adapter report. The op remains
   * queued while this timestamp is in the future, so process restart resumes
   * the same retry instead of losing an in-memory timer. */
  retryNotBefore?: string | null;
  /** Durable unattended runtime failover state. Exact identities are
   * content-free and bind every transition to one signed runtime target. */
  runtimeFailover?: RuntimeFailoverState;
  /** Durable scheduler-to-backend placement. Absence is the legacy
   * in-process shape; the scheduler stamps it before the first backend start. */
  executionPlacement?: ExecutionPlacement;
}

export interface RuntimeFailoverState {
  schemaVersion: 1;
  phase: "cooldown" | "waiting";
  currentTargetIdentity: string;
  candidateTargetIdentity: string | null;
  attemptedTargetIdentities: string[];
  normalizedFailure: string;
  retryNotBefore: string;
  revision: number;
  /** Bounded exact-target attempt outcomes. These receipts contain hashes and
   * routing facts only; candidate scoring still re-runs every live U5 gate. */
  feedback?: RuntimeRoutingFeedback[];
}

export interface RuntimeRoutingFeedback {
  schemaVersion: 1;
  routingIdentity: string;
  compatibilityKey: string;
  outcome: "success" | "failure";
  recordedAt: number;
}

export type ExecutionPlacementDisposition = "ready" | "waiting";

export interface ExecutionPlacement {
  schemaVersion: 1;
  backendId: string;
  targetId: string;
  disposition: ExecutionPlacementDisposition;
  /** Exact backend-issued token required to wake a waiting placement. */
  wakeToken: string | null;
  wakeRequestedAt: string | null;
  /** Monotonic metadata fence. Every accepted wake advances it. */
  revision: number;
}

// ── op_turns row (PRD §11) ────────────────────────────────────────────────

export interface OpTurnRow {
  opId: string;
  turnIdx: number;
  providerState: ProviderStateEnvelope;
  toolCallSummary: ToolCallSummary[];
  /**
   * Tools the PROVIDER executed out of band (the Anthropic CLI/MCP path,
   * where Claude runs LAX tools inside the `claude` subprocess and surfaces
   * them only as `mcp_activity`). Recorded for op-category telemetry ONLY.
   * Kept SEPARATE from `toolCallSummary` on purpose: the middleware
   * `toolsCalledThisOp` / `committingToolsThisOp` tallies read toolCallSummary,
   * and an out-of-band tool must not perturb their gating. Names may carry an
   * `mcp__<server>__` prefix — callers normalize at read time, not here.
   */
  observedTools?: string[];
  terminalReason: "done" | "error" | "cancelled" | null;
  redirectConsumed: boolean;
  createdAt: string;
  /**
   * Wall-clock spent inside `adapter.runTurn` (model thinking + provider
   * round-trip). Excludes tool dispatch and post-turn commit work.
   * Soak telemetry sums across rounds for the per-op `modelMs` column.
   */
  modelMs?: number;
  /**
   * Wall-clock spent inside `dispatchTools` (sum of every tool's
   * dispatch duration this turn). Soak telemetry sums across rounds.
   */
  toolDispatchMs?: number;
  /** A strategy pivot selected from this turn's completed tool results.
   *  Stored in the turn row so a crash after commit cannot lose the next-turn
   *  instruction. Materialization into op_messages is idempotent. */
  nextTurnPivot?: {
    message: string;
    metadata: {
      strategyPivot: {
        pattern: string;
        strategyId: string;
        epoch: number;
      };
    };
  };
}

/**
 * Dispatch-boundary status — the tool-result envelope's flavor as recorded by
 * the canonical dispatcher, plus "cancelled" (op-cancel bookkeeping, never
 * produced by the envelope itself). Derived from ToolResultStatus so the
 * 6-state envelope (src/types.ts) stays the single source of truth; "running"
 * is excluded because the boundary maps it to "ok" (the START succeeded —
 * committedWork semantics, see chat-tool-dispatcher.ts).
 */
export type ToolDispatchStatus = Exclude<ToolResultStatus, "running"> | "cancelled";

/**
 * True for the statuses that meant "error" before the boundary carried the
 * envelope flavor (error | blocked | declined | timeout). Failure-side
 * consumers that used to string-match "error" key on this instead, so the
 * widened union cannot silently flip their ok-vs-failure decisions.
 * "cancelled" is deliberately NOT a failure here — it never was one.
 */
export function isDispatchFailure(status: string | undefined): boolean {
  return status === "error" || status === "blocked" || status === "declined" || status === "timeout";
}

export interface ToolCallSummary {
  tool: string;
  argsHash: string;
  resultStatus: ToolDispatchStatus;
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
  | "iteration_checkpoint"
  | "tool_started"
  | "tool_finished"
  | "message_appended"
  | "redirect_received"
  | "redirect_applied"
  | "pause_requested"
  | "resume_requested"
  | "approval_requested"
  | "approval_resolved"
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
