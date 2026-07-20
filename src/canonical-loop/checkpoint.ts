/** Failure-atomic, lease-fenced post-turn commit. */
import { randomUUID } from "node:crypto";
import { aggregateOpUsage } from "./op-usage.js";
import { emitStrict } from "./event-emitter.js";
import { isLeaseExpired, withCurrentLeaseClaim, type LeaseClaim } from "./lease.js";
import { persistOpKeepingSignalsStrict, StrictOpPersistenceError } from "./op-persist.js";
import { recordSessionBaselineObservation } from "./session-baseline.js";
import { transitionOp } from "./state-machine.js";
import { readCanonicalEvents, readLatestOpTurn, readOpMessages, readOpTurn, readOpTurns } from "./store.js";
import {
  publishTurnCommit,
  quarantineInvalidTurnArtifact,
  readTurnArtifact,
  scavengeTurnCommitStages,
  type TurnCommitEnvelope,
} from "./turn-commit-store.js";
import { hasMessageCollision, isTurnCommitEnvelope } from "./turn-commit-validation.js";
import { appendActionLedgerOnce } from "../ops/action-ledger.js";
import { readOp, tryWithOpLock } from "../ops/op-store.js";
import type { Op } from "../ops/types.js";
import type { LearnedOutcome } from "../protocols/learned-effectiveness.js";
import type {
  CanonicalEventType,
  CanonicalMessageRole,
  OpMessageRow,
  OpTurnRow,
  ProviderStateEnvelope,
  ToolCallSummary,
} from "./types.js";

export interface CommitTurnMessage {
  messageId?: string;
  role: CanonicalMessageRole;
  content: unknown;
}

export interface CommitTurnInput {
  op: Op;
  leaseClaim?: LeaseClaim;
  turnIdx: number;
  providerState: ProviderStateEnvelope;
  messages: CommitTurnMessage[];
  toolCallSummary: ToolCallSummary[];
  observedTools?: string[];
  terminalReason: "done" | "error" | null;
  learnedOutcome?: LearnedOutcome;
  learningSessionId?: string;
  redirectConsumed?: boolean;
  redirectInstructionId?: string;
  redirectText?: string;
  modelMs?: number;
  toolDispatchMs?: number;
  nextTurnPivot?: OpTurnRow["nextTurnPivot"];
}

export interface CommitTurnOutput {
  turn: OpTurnRow;
  messages: OpMessageRow[];
  inserted: boolean;
}

export class TurnCommitFenceError extends Error {
  constructor(public readonly opId: string, public readonly reason: string) {
    super(`turn commit rejected for ${opId}: ${reason}`);
    this.name = "TurnCommitFenceError";
  }
}

export type TurnProjectionPoint =
  | "before_checkpoint"
  | "after_checkpoint"
  | "after_message_events"
  | "after_turn_event"
  | "after_action_ledger"
  | "before_terminal"
  | "after_terminal";
let projectionHook: ((point: TurnProjectionPoint) => void) | null = null;

export function _setTurnProjectionHookForTests(
  hook: ((point: TurnProjectionPoint) => void) | null,
): void {
  projectionHook = hook;
}

export function commitTurn(input: CommitTurnInput): CommitTurnOutput {
  const leaseClaim = input.leaseClaim;
  if (!leaseClaim) throw new TurnCommitFenceError(input.op.id, "missing_claim");
  const guarded = withCurrentLeaseClaim(input.op.id, leaseClaim, (current) =>
    commitOwnedTurn({ ...input, op: current, leaseClaim }));
  if (!guarded.ok) throw new TurnCommitFenceError(input.op.id, guarded.reason);
  Object.assign(input.op, readOp(input.op.id) ?? input.op);
  return guarded.value;
}

/** Repair projections after a process died after the envelope rename. The
 * replacement must first own a fresh exact lease generation. */
export function reconcileLatestTurnCommit(opId: string, leaseClaim: LeaseClaim): boolean {
  const guarded = withCurrentLeaseClaim(opId, leaseClaim, (op) => {
    const latest = readLatestOpTurn(opId);
    if (!latest) return false;
    const artifact = readTurnArtifact(opId, latest.turnIdx);
    if (!artifact || !("turn" in artifact)) return false;
    projectTurnCommit(op, artifact);
    return true;
  });
  if (!guarded.ok) throw new TurnCommitFenceError(opId, guarded.reason);
  return guarded.value;
}

/** Process recovery path. It repairs evidence for every published envelope
 * under the op lock, but never overrides pause/cancel/approval control. */
export function reconcilePublishedTurnCommitsForRecovery(opId: string): boolean {
  try {
    const locked = tryWithOpLock(opId, () => {
      const op = readOp(opId);
      if (!op?.canonical?.flagValue) return false;
      let repaired = false;
      for (const turn of readOpTurns(opId)) {
        const artifact = readTurnArtifact(opId, turn.turnIdx);
        if (!artifact || !("turn" in artifact)) continue;
        projectTurnCommit(op, artifact, "recovery");
        repaired = true;
      }
      return repaired;
    });
    return locked.acquired && locked.value;
  } catch {
    return false;
  }
}

function commitOwnedTurn(input: CommitTurnInput & { leaseClaim: LeaseClaim }): CommitTurnOutput {
  scavengeTurnCommitStages(input.op.id);
  const existingArtifact = readTurnArtifact(input.op.id, input.turnIdx);
  if (existingArtifact) {
    if ("turn" in existingArtifact) projectTurnCommit(input.op, existingArtifact);
    else persistCheckpoint(input.op, input.turnIdx, false);
    return { turn: "turn" in existingArtifact ? existingArtifact.turn : existingArtifact, messages: [], inserted: false };
  }
  quarantineInvalidTurnArtifact(input.op.id, input.turnIdx);

  const promptMessages = readOpMessages(input.op.id);
  const turnMessages = promptMessages.filter((row) => row.turnIdx === input.turnIdx);
  const seqBase = turnMessages.reduce((max, row) => Math.max(max, row.seqInTurn + 1), 0);
  const createdAt = new Date().toISOString();
  const turn: OpTurnRow = {
    opId: input.op.id,
    turnIdx: input.turnIdx,
    providerState: input.providerState,
    toolCallSummary: input.toolCallSummary,
    terminalReason: input.terminalReason,
    redirectConsumed: input.redirectConsumed === true,
    createdAt,
    ...(input.observedTools?.length ? { observedTools: input.observedTools } : {}),
    ...(input.modelMs !== undefined ? { modelMs: input.modelMs } : {}),
    ...(input.toolDispatchMs !== undefined ? { toolDispatchMs: input.toolDispatchMs } : {}),
    ...(input.nextTurnPivot ? { nextTurnPivot: input.nextTurnPivot } : {}),
  };
  const messages = input.messages.map((message, index): OpMessageRow => ({
    messageId: message.messageId ?? `msg-${randomUUID()}`,
    opId: input.op.id,
    turnIdx: input.turnIdx,
    seqInTurn: seqBase + index,
    role: message.role,
    content: message.content,
    createdAt,
  }));
  const envelope: TurnCommitEnvelope = {
    schemaVersion: 1,
    turn,
    messages,
    projection: {
      opType: input.op.type,
      task: input.op.task,
      sessionId: input.op.canonical?.sessionId ?? "",
      learnedOutcome: input.learnedOutcome,
      learningSessionId: input.learningSessionId,
      redirectInstructionId: input.redirectInstructionId,
      redirectText: input.redirectText,
      appUrl: input.op.appUrl,
      stateBefore: input.op.canonical?.state,
    },
  };
  if (!isTurnCommitEnvelope(envelope) || hasMessageCollision(messages, promptMessages)) {
    throw new Error(`turn commit message collision or invalid envelope for ${input.op.id}#${input.turnIdx}`);
  }

  if (!publishTurnCommit(envelope)) {
    const winner = readTurnArtifact(input.op.id, input.turnIdx);
    if (!winner) throw new Error(`turn commit publish raced without artifact for ${input.op.id}#${input.turnIdx}`);
    if ("turn" in winner) projectTurnCommit(input.op, winner);
    else persistCheckpoint(input.op, input.turnIdx, false);
    return { turn: "turn" in winner ? winner.turn : winner, messages: [], inserted: false };
  }

  try {
    recordSessionBaselineObservation(
      input.op.canonical?.sessionId,
      input.op.type,
      input.providerState,
      input.observedTools,
      promptMessages,
    );
  } catch { /* non-authoritative sizing hint */ }
  projectTurnCommit(input.op, envelope);
  return { turn, messages, inserted: true };
}

/** Idempotently materialize all projections from the published envelope.
 * Called on ordinary commit and on a same-generation replay after a crash. */
function projectTurnCommit(
  op: Op,
  envelope: TurnCommitEnvelope,
  terminalMode: "owned" | "recovery" = "owned",
): void {
  const { turn, messages, projection } = envelope;
  const clearRedirect = turn.redirectConsumed
    && projection.redirectInstructionId != null
    && diskRedirectMatches(op.id, projection.redirectInstructionId);
  if (turn.terminalReason === "done" && projection.appUrl) {
    const url = (turn.providerState.providerPayload as { url?: unknown } | null)?.url;
    if (typeof url === "string" && url) op.appUrl = url;
  }
  projectionHook?.("before_checkpoint");
  persistCheckpoint(op, turn.turnIdx, clearRedirect);
  projectionHook?.("after_checkpoint");

  for (const row of messages) {
    emitOnce(op.id, "message_appended", (body) => body.messageId === row.messageId, {
      turnIdx: turn.turnIdx,
      role: row.role,
      messageId: row.messageId,
    });
  }
  projectionHook?.("after_message_events");
  const usage = aggregateOpUsage(op.id);
  emitOnce(op.id, "turn_committed", (body) => body.turnIdx === turn.turnIdx, {
    turnIdx: turn.turnIdx,
    messageCount: messages.length,
    toolCount: turn.toolCallSummary.length,
    tools: turn.toolCallSummary.map((item) => ({ tool: item.tool, status: item.resultStatus })),
    usage: {
      inputTokens: usage.usageInputTokens,
      outputTokens: usage.usageOutputTokens,
      totalTokens: usage.usageInputTokens + usage.usageOutputTokens,
    },
  });
  projectionHook?.("after_turn_event");
  appendActionLedgerOnce({
    ts: turn.createdAt,
    sessionId: projection.sessionId,
    opId: op.id,
    opType: projection.opType,
    turnIdx: turn.turnIdx,
    task: projection.task,
    actions: turn.toolCallSummary.map((item) => ({ tool: item.tool, status: item.resultStatus })),
    terminalReason: turn.terminalReason === "cancelled" ? null : turn.terminalReason,
  });
  projectionHook?.("after_action_ledger");
  if (turn.redirectConsumed && projection.redirectInstructionId) {
    emitOnce(op.id, "redirect_applied", (body) =>
      body.turnIdx === turn.turnIdx && body.instructionId === projection.redirectInstructionId, {
      turnIdx: turn.turnIdx,
      instructionId: projection.redirectInstructionId,
      ...(projection.redirectText ? { text: projection.redirectText } : {}),
    });
  }
  const terminal = turn.terminalReason === "done" ? "succeeded"
    : turn.terminalReason === "error" ? "failed" : null;
  const terminalReason = turn.terminalReason === "done" ? "turn_done" : "turn_error";
  projectionHook?.("before_terminal");
  const state = op.canonical?.state;
  const controlBlocksTerminal = terminalMode === "recovery" && (
    state === "paused" || state === "cancelling" || state === "cancelled"
    || !!op.canonical?.pendingApproval || !!op.canonical?.pauseRequestedAt
    || !!op.canonical?.cancelRequestedAt
  );
  const recoveryMayTransition = terminalMode === "owned"
    || (state === "running" && !controlBlocksTerminal
      && (!op.canonical?.leaseOwner || isLeaseExpired(op)));
  if (terminal && state !== terminal && recoveryMayTransition) {
    transitionOp(op, terminal, terminalReason, {
      learnedOutcome: projection.learnedOutcome,
      learningSessionId: projection.learningSessionId,
      strictPersistence: true,
    });
  }
  if (terminal && op.canonical?.state === terminal) {
    emitOnce(op.id, "state_changed", (body) =>
      body.to === terminal && body.reason === terminalReason, {
      from: projection.stateBefore ?? "running",
      to: terminal,
      reason: terminalReason,
    });
  }
  projectionHook?.("after_terminal");
}

function persistCheckpoint(op: Op, turnIdx: number, clearRedirect: boolean): void {
  if (!op.canonical) op.canonical = {};
  op.canonical.currentTurnIdx = Math.max(op.canonical.currentTurnIdx ?? -1, turnIdx);
  op.canonical.currentCheckpointId = `${op.id}#${turnIdx}`;
  if (clearRedirect) {
    op.canonical.redirectInstruction = null;
    op.canonical.redirectReceivedAt = null;
  }
  if (!persistOpKeepingSignalsStrict(op, { clearRedirect })) throw new StrictOpPersistenceError(op.id);
}

function emitOnce(
  opId: string,
  type: CanonicalEventType,
  matches: (body: Record<string, unknown>) => boolean,
  body: Record<string, unknown>,
): void {
  if (readCanonicalEvents(opId).some((event) =>
    event.type === type && matches(event.body ?? {}))) return;
  emitStrict(opId, type, body);
}

function diskRedirectMatches(opId: string, instructionId: string): boolean {
  return readOp(opId)?.canonical?.redirectInstruction?.instructionId === instructionId;
}
