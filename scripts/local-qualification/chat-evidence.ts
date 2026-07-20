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
  const startArgs = starts[0]?.args;
  const startIndex = events.indexOf(starts[0]);
  const endIndex = events.indexOf(ends[0]);
  const doneIndices = events.flatMap((event, index) => event.type === "done" ? [index] : []);
  const doneIndex = doneIndices[0] ?? -1;
  const exactReadResult = `1\t${READ_NONCE}\n2\t`;
  const lifecycle = starts.length === 1 && ends.length === 1
    && startIndex >= 0
    && endIndex > startIndex
    && typeof starts[0].toolCallId === "string"
    && starts[0].toolCallId === ends[0].toolCallId
    && typeof startArgs === "object"
    && startArgs !== null
    && (startArgs as Record<string, unknown>).path === "workspace/qualification-note.txt"
    && ends[0].allowed === true
    && ends[0].status === "ok"
    && ends[0].result === exactReadResult;
  const prelude = events.slice(0, startIndex);
  const validPrelude = prelude.length === 2
    && isContextStatus(prelude[0])
    && isChatOperationStarted(prelude[1]);
  const continuation = events.slice(endIndex + 1, doneIndex);
  const validContinuation = continuation.length > 0
    && continuation.every((event) => event.type === "stream" && typeof event.delta === "string");
  const readContinuation = validContinuation
    ? continuation.map((event) => String(event.delta)).join("")
    : "";
  const exactReadContinuation = lifecycle
    && validPrelude
    && endIndex === startIndex + 1
    && doneIndices.length === 1
    && doneIndex === events.length - 1
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
  return hasExactKeys(event, ["type", "percentage", "level", "usedTokens", "maxTokens", "compacted"])
    && event.type === "context_status"
    && typeof event.percentage === "number"
    && typeof event.level === "string"
    && typeof event.usedTokens === "number"
    && typeof event.maxTokens === "number"
    && typeof event.compacted === "boolean";
}

function isChatOperationStarted(event: Record<string, unknown>): boolean {
  return hasExactKeys(event, ["type", "opId"])
    && event.type === "chat_op_started"
    && typeof event.opId === "string";
}

function hasExactKeys(event: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(event);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(event, key));
}

export async function readSse(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  const events: Array<Record<string, unknown>> = [];
  for (const frame of text.split(/\r?\n\r?\n/)) {
    for (const line of frame.split(/\r?\n/)) {
      if (!line.startsWith("data: ")) continue;
      try { events.push(JSON.parse(line.slice(6)) as Record<string, unknown>); } catch { /* ignore malformed frame */ }
    }
  }
  return events;
}
