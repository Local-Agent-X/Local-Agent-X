import type { TurnCommitEnvelope, TurnCommitProjection } from "./turn-commit-store.js";
import { TOOL_DISPATCH_STATUSES, type OpMessageRow, type OpTurnRow, type ToolCallSummary } from "./types.js";
import type { Op } from "../ops/types.js";

const ROLES = new Set(["system", "user", "assistant", "tool_result", "control"]);
const TOOL_STATUSES = new Set<string>(TOOL_DISPATCH_STATUSES);
const TERMINALS = new Set(["done", "error", "cancelled", null]);
const STATES = new Set(["queued", "running", "paused", "cancelling", "cancelled", "succeeded", "failed"]);
const LEARNED = new Set(["clean", "partial", "aborted"]);

export function isTurnCommitEnvelope(value: unknown): value is TurnCommitEnvelope {
  return turnCommitEnvelopeProblem(value) === null;
}

/** What makes `value` not a turn commit envelope, in words a log can carry
 *  (a turn row names its failing fields); null when it is one. */
export function turnCommitEnvelopeProblem(value: unknown): string | null {
  if (!record(value)) return "not an object";
  const envelope = value as Partial<TurnCommitEnvelope>;
  if (envelope.schemaVersion !== 1) return "schemaVersion is not 1";
  const badTurnFields = turnRowProblems(envelope.turn, isProviderState);
  if (badTurnFields.length > 0) return `invalid turn row: ${badTurnFields.join(", ")}`;
  if (!Array.isArray(envelope.messages)) return "messages is not an array";
  const badMessage = envelope.messages.findIndex((row) => !isOpMessageRow(row));
  if (badMessage >= 0) return `invalid message row at ${badMessage}`;
  if (!isProjection(envelope.projection)) return "invalid projection";
  const turn = envelope.turn as OpTurnRow;
  const ids = new Set<string>();
  const positions = new Set<string>();
  for (const row of envelope.messages as OpMessageRow[]) {
    if (row.opId !== turn.opId || row.turnIdx !== turn.turnIdx) return `message ${row.messageId} belongs to another turn`;
    const position = messagePosition(row);
    if (ids.has(row.messageId) || positions.has(position)) return `message ${row.messageId} appears twice`;
    ids.add(row.messageId);
    positions.add(position);
  }
  return null;
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
  return turnRowProblems(value, providerValid).length === 0;
}

/** The fields of a turn row that fail their check; empty for a valid row. */
function turnRowProblems(value: unknown, providerValid: (value: unknown) => boolean): string[] {
  if (!record(value)) return ["not an object"];
  const row = value as Partial<OpTurnRow>;
  const checks: Array<[string, boolean]> = [
    ["opId", typeof row.opId === "string"],
    ["turnIdx", integer(row.turnIdx)],
    ["providerState", providerValid(row.providerState)],
    ["toolCallSummary", Array.isArray(row.toolCallSummary) && row.toolCallSummary.every(isToolSummary)],
    ["terminalReason", TERMINALS.has(row.terminalReason as never)],
    ["redirectConsumed", typeof row.redirectConsumed === "boolean"],
    ["createdAt", typeof row.createdAt === "string"],
    ["observedTools", optionalStringArray(row.observedTools)],
    [`modelMs=${row.modelMs}`, optionalFinite(row.modelMs)],
    [`toolDispatchMs=${row.toolDispatchMs}`, optionalFinite(row.toolDispatchMs)],
    ["nextTurnPivot", isNextTurnPivot(row.nextTurnPivot)],
  ];
  return checks.filter(([, ok]) => !ok).map(([name]) => name);
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
    && finite(value.durationMs)
    // Optional on purpose: turns written before the dispatch-time verdict
    // existed have no `committing` key and must keep validating.
    && (value.committing === undefined || typeof value.committing === "boolean");
}

function isProjection(value: unknown): value is TurnCommitProjection {
  if (!record(value)) return false;
  return typeof value.opType === "string" && typeof value.sessionId === "string"
    && optionalString(value.task) && optionalString(value.learningSessionId)
    && optionalString(value.redirectInstructionId) && optionalString(value.redirectText)
    && optionalString(value.appUrl) && optionalString(value.failureReason)
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
  if (value.firedBy !== undefined && typeof value.firedBy !== "string") return false;
  const pivot = value.metadata.strategyPivot;
  return typeof pivot.pattern === "string" && typeof pivot.strategyId === "string"
    && integer(pivot.epoch);
}

export function messagePosition(row: OpMessageRow): string {
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
