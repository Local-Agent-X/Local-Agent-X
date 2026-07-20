import type { ChatResult } from "./types.js";

export const MARKER = "LAX_QUALIFICATION_CONTINUITY_7F31";
export const READ_NONCE = "LAX_QUALIFICATION_READ_8C42";
const FORBIDDEN_CONTROL_EVENTS = new Set([
  "approval_requested",
  "approval_resolved",
  "approval_timeout",
  "secret_request",
  "secrets_request",
]);
const KNOWN_EVENT_TYPES = new Set([
  "stream", "reasoning", "tool_start", "tool_progress", "tool_end", "usage", "done", "stopped", "error",
  "secret_request", "secrets_request", "approval_requested", "approval_timeout", "approval_resolved",
  "context_status", "visual", "bg_op_queued", "bg_op_queue_reordered", "bg_op_started", "bg_op_progress",
  "bg_op_completed", "bg_op_nudge", "av_blocked_warning", "worker_stream", "worker_done", "chat_op_started",
  "inject_queued", "inject_consumed", "plan_mode_changed", "tool_chip", "op_heartbeat",
]);
const INVALID_SSE_MESSAGE = "qualification received invalid SSE data";

export type QualificationChatKind = "baseline" | "workspace-read" | "history" | "continuity";

export function qualificationPrompt(kind: QualificationChatKind): string {
  return {
    baseline: `Remember ${MARKER}. Reply with exactly READY.`,
    "workspace-read": "Use the read tool on workspace/qualification-note.txt. Then reply with exactly the file contents you read, without line numbers or explanation.",
    history: `Keep remembering ${MARKER}. Reply with exactly ACK.`,
    continuity: "From the earlier compacted context, reply with the exact continuity marker and nothing else.",
  }[kind];
}

export function chatEvidence(events: Array<Record<string, unknown>>): ChatResult {
  const text = events.filter((event) => event.type === "stream" && typeof event.delta === "string")
    .map((event) => String(event.delta)).join("");
  const starts = events.filter((event) => event.type === "tool_start" && event.toolName === "read");
  const ends = events.filter((event) => event.type === "tool_end" && event.toolName === "read");
  const startIndex = events.indexOf(starts[0]);
  const endIndex = events.indexOf(ends[0]);
  const doneIndices = events.flatMap((event, index) => event.type === "done" ? [index] : []);
  const doneIndex = doneIndices[0] ?? -1;
  const exactReadResult = `1\t${READ_NONCE}\n2\t`;
  const lifecycle = starts.length === 1 && ends.length === 1
    && endIndex === startIndex + 1
    && isToolStart(starts[0])
    && isToolEnd(ends[0], String(starts[0].toolCallId), exactReadResult);
  const prelude = events.slice(0, startIndex);
  const validPrelude = prelude.length === 2
    && isContextStatus(prelude[0])
    && isChatOperationStarted(prelude[1])
    && !containsNonce(events.slice(0, endIndex));
  const continuation = events.slice(endIndex + 1, doneIndex);
  const validContinuation = continuation.length > 0
    && continuation.every(isAppendStream);
  const readContinuation = validContinuation
    ? continuation.map((event) => String(event.delta)).join("")
    : "";
  const exactReadContinuation = lifecycle
    && validPrelude
    && doneIndices.length === 1
    && doneIndex === events.length - 1
    && isDone(events[doneIndex])
    && validContinuation
    && readContinuation.replaceAll("\r\n", "\n").trim() === READ_NONCE;
  return {
    done: events.some((event) => event.type === "done"),
    hasText: text.trim().length > 0,
    errorEvents: events.filter((event) => event.type === "error").length,
    safeReadLifecycle: lifecycle,
    forbiddenControlEvents: events.filter((event) => FORBIDDEN_CONTROL_EVENTS.has(String(event.type))).length,
    readNonceSeen: exactReadContinuation,
    continuityMarkerSeen: text.includes(MARKER),
  };
}

function isContextStatus(event: Record<string, unknown>): boolean {
  return hasExactOwnKeys(event, ["type", "percentage", "level", "usedTokens", "maxTokens", "compacted"])
    && event.type === "context_status"
    && event.percentage === 0
    && event.level === "ok"
    && isNonnegativeInteger(event.usedTokens)
    && isPositiveInteger(event.maxTokens)
    && event.compacted === false;
}

function isChatOperationStarted(event: Record<string, unknown>): boolean {
  return hasExactOwnKeys(event, ["type", "opId"])
    && event.type === "chat_op_started"
    && isNonemptyString(event.opId);
}

function isToolStart(event: Record<string, unknown>): boolean {
  if (!hasExactOwnKeys(event, ["type", "toolName", "toolCallId", "args", "riskLevel", "context", "requiresApproval"])) return false;
  if (!isPlainRecord(event.args) || !hasExactOwnKeys(event.args, ["path", "_sessionId"])) return false;
  return event.type === "tool_start"
    && event.toolName === "read"
    && isNonemptyString(event.toolCallId)
    && event.args.path === "workspace/qualification-note.txt"
    && isNonemptyString(event.args._sessionId)
    && event.riskLevel === "low"
    && event.context === "Read file: qualification-note.txt"
    && event.requiresApproval === false;
}

function isToolEnd(event: Record<string, unknown>, callId: string, result: string): boolean {
  if (!hasExactOwnKeys(event, ["type", "toolName", "toolCallId", "result", "allowed", "status", "metadata"])) return false;
  if (!isPlainRecord(event.metadata)
    || !hasExactOwnKeys(event.metadata, ["path", "bytes", "total_lines", "lines_shown"])) return false;
  return event.type === "tool_end"
    && event.toolName === "read"
    && event.toolCallId === callId
    && event.result === result
    && event.allowed === true
    && event.status === "ok"
    && isQualificationNotePath(event.metadata.path)
    && event.metadata.bytes === 28
    && event.metadata.total_lines === 2
    && event.metadata.lines_shown === 2;
}

function isAppendStream(event: Record<string, unknown>): boolean {
  return hasExactOwnKeys(event, ["type", "delta"])
    && event.type === "stream"
    && typeof event.delta === "string";
}

function isDone(event: Record<string, unknown> | undefined): boolean {
  if (!event || !hasExactOwnKeys(event, ["type", "usage"]) || !isPlainRecord(event.usage)) return false;
  if (!hasExactOwnKeys(event.usage, ["promptTokens", "completionTokens", "totalTokens"])) return false;
  return event.type === "done"
    && isNonnegativeInteger(event.usage.promptTokens)
    && isNonnegativeInteger(event.usage.completionTokens)
    && event.usage.totalTokens === Number(event.usage.promptTokens) + Number(event.usage.completionTokens);
}

function hasExactOwnKeys(event: Record<string, unknown>, keys: string[]): boolean {
  if (!isPlainRecord(event)) return false;
  const actual = Reflect.ownKeys(event);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(event, key));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function containsNonce(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === "string") return value.includes(READ_NONCE);
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  return Reflect.ownKeys(value).some((key) => (
    (typeof key === "string" && key.includes(READ_NONCE))
    || containsNonce(Reflect.get(value, key), seen)
  ));
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isQualificationNotePath(value: unknown): boolean {
  return typeof value === "string" && /[\\/]qualification-note\.txt$/.test(value);
}

export async function readSse(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  const events: Array<Record<string, unknown>> = [];
  for (const frame of text.split(/\r?\n\r?\n/)) {
    for (const line of frame.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).replace(/^ /, "");
      try {
        const parsed: unknown = JSON.parse(payload);
        if (!isPlainRecord(parsed) || typeof parsed.type !== "string" || !KNOWN_EVENT_TYPES.has(parsed.type)) {
          events.push({ type: "error", message: INVALID_SSE_MESSAGE });
        } else {
          events.push(parsed);
        }
      } catch {
        events.push({ type: "error", message: INVALID_SSE_MESSAGE });
      }
    }
  }
  return events;
}
