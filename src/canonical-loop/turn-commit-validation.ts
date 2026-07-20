import type { TurnCommitEnvelope, TurnCommitProjection } from "./turn-commit-store.js";
import type { OpMessageRow, OpTurnRow, ToolCallSummary } from "./types.js";
import type { Op } from "../ops/types.js";

const ROLES = new Set(["system", "user", "assistant", "tool_result", "control"]);
const TOOL_STATUSES = new Set(["ok", "error", "blocked", "declined", "timeout", "cancelled"]);
const TERMINALS = new Set(["done", "error", "cancelled", null]);
const STATES = new Set(["queued", "running", "paused", "cancelling", "cancelled", "succeeded", "failed"]);
const LEARNED = new Set(["clean", "partial", "aborted"]);

export function isTurnCommitEnvelope(value: unknown): value is TurnCommitEnvelope {
  if (!record(value)) return false;
  const envelope = value as Partial<TurnCommitEnvelope>;
  if (envelope.schemaVersion !== 1 || !isOpTurnRow(envelope.turn)
    || !Array.isArray(envelope.messages) || !envelope.messages.every(isOpMessageRow)
    || !isProjection(envelope.projection)) return false;
  const ids = new Set<string>();
  const positions = new Set<string>();
  for (const row of envelope.messages) {
    if (row.opId !== envelope.turn.opId || row.turnIdx !== envelope.turn.turnIdx) return false;
    const position = messagePosition(row);
    if (ids.has(row.messageId) || positions.has(position)) return false;
    ids.add(row.messageId);
    positions.add(position);
  }
  return true;
}

export function isOpTurnRow(value: unknown): value is OpTurnRow {
  return isOpTurnRowWithProvider(value, isProviderState);
}

export function isLegacyOpTurnRow(value: unknown): value is OpTurnRow {
  return isOpTurnRowWithProvider(value, (provider) => isProviderState(provider)
    || (record(provider) && typeof provider.kind === "string"
      && Object.prototype.hasOwnProperty.call(provider, "state")));
}

function isOpTurnRowWithProvider(
  value: unknown,
  providerValid: (value: unknown) => boolean,
): value is OpTurnRow {
  if (!record(value)) return false;
  const row = value as Partial<OpTurnRow>;
  return typeof row.opId === "string" && integer(row.turnIdx)
    && providerValid(row.providerState)
    && Array.isArray(row.toolCallSummary) && row.toolCallSummary.every(isToolSummary)
    && TERMINALS.has(row.terminalReason as never)
    && typeof row.redirectConsumed === "boolean" && typeof row.createdAt === "string"
    && optionalStringArray(row.observedTools)
    && optionalFinite(row.modelMs) && optionalFinite(row.toolDispatchMs)
    && isNextTurnPivot(row.nextTurnPivot);
}

export function isOpMessageRow(value: unknown): value is OpMessageRow {
  if (!record(value)) return false;
  const row = value as Partial<OpMessageRow>;
  return typeof row.messageId === "string" && typeof row.opId === "string"
    && integer(row.turnIdx) && integer(row.seqInTurn)
    && typeof row.role === "string" && ROLES.has(row.role)
    && Object.prototype.hasOwnProperty.call(row, "content")
    && typeof row.createdAt === "string";
}

export function hasMessageCollision(
  messages: readonly OpMessageRow[],
  existing: readonly OpMessageRow[],
): boolean {
  const ids = new Set(existing.map((row) => row.messageId));
  const positions = new Set(existing.map(messagePosition));
  return messages.some((row) => ids.has(row.messageId) || positions.has(messagePosition(row)));
}

/** Current operation.json is authoritative for projection routing. Legacy ops
 * without a session use the historical empty-session identity; malformed
 * identity fields reject envelopes rather than guessing a foreign target. */
export function projectionMatchesOp(projection: TurnCommitProjection, op: Op): boolean {
  if (typeof op.type !== "string" || typeof op.task !== "string") return false;
  const persistedSession = op.canonical?.sessionId;
  if (persistedSession !== undefined && typeof persistedSession !== "string") return false;
  return projection.opType === op.type
    && projection.task === op.task
    && projection.sessionId === (persistedSession ?? "");
}

function isProviderState(value: unknown): boolean {
  if (!record(value)) return false;
  return typeof value.adapterName === "string" && typeof value.adapterVersion === "string"
    && Object.prototype.hasOwnProperty.call(value, "providerPayload")
    && (value.viewCompacted === undefined || typeof value.viewCompacted === "boolean");
}

function isToolSummary(value: unknown): value is ToolCallSummary {
  if (!record(value)) return false;
  return typeof value.tool === "string" && typeof value.argsHash === "string"
    && typeof value.resultStatus === "string" && TOOL_STATUSES.has(value.resultStatus)
    && finite(value.durationMs);
}

function isProjection(value: unknown): value is TurnCommitProjection {
  if (!record(value)) return false;
  return typeof value.opType === "string" && typeof value.sessionId === "string"
    && optionalString(value.task) && optionalString(value.learningSessionId)
    && optionalString(value.redirectInstructionId) && optionalString(value.redirectText)
    && optionalString(value.appUrl)
    && (value.learnedOutcome === undefined || LEARNED.has(value.learnedOutcome as string))
    && isRoutingFeedback(value.routingFeedback)
    && (value.stateBefore === undefined || STATES.has(value.stateBefore as string));
}

function isRoutingFeedback(value: unknown): boolean {
  if (value === undefined) return true;
  if (!record(value)) return false;
  return value.schemaVersion === 1
    && typeof value.routingIdentity === "string" && /^[a-f0-9]{64}$/.test(value.routingIdentity)
    && typeof value.compatibilityKey === "string" && /^[a-f0-9]{64}$/.test(value.compatibilityKey)
    && (value.outcome === "success" || value.outcome === "failure")
    && integer(value.recordedAt);
}

function isNextTurnPivot(value: unknown): boolean {
  if (value === undefined) return true;
  if (!record(value) || typeof value.message !== "string" || !record(value.metadata)
    || !record(value.metadata.strategyPivot)) return false;
  const pivot = value.metadata.strategyPivot;
  return typeof pivot.pattern === "string" && typeof pivot.strategyId === "string"
    && integer(pivot.epoch);
}

function messagePosition(row: OpMessageRow): string {
  return `${row.turnIdx}:${row.seqInTurn}`;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function optionalFinite(value: unknown): boolean { return value === undefined || finite(value); }
function optionalString(value: unknown): boolean { return value === undefined || typeof value === "string"; }
function optionalStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}
