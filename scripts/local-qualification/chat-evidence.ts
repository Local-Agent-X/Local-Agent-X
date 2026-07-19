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
    "workspace-read": `Use the read tool on workspace/qualification-note.txt. Then reply with exactly ${READ_NONCE}.`,
    history: `Keep remembering ${MARKER}. Reply with exactly ACK.`,
    continuity: "From the earlier compacted context, reply with the exact continuity marker and nothing else.",
  }[kind];
}

export function chatEvidence(events: Array<Record<string, unknown>>): ChatResult {
  const text = events.filter((event) => event.type === "stream" && typeof event.delta === "string")
    .map((event) => String(event.delta)).join("");
  const starts = events.filter((event) => event.type === "tool_start" && event.toolName === "read");
  const ends = events.filter((event) => event.type === "tool_end" && event.toolName === "read");
  const lifecycle = starts.length === 1 && ends.length === 1
    && typeof starts[0].toolCallId === "string"
    && starts[0].toolCallId === ends[0].toolCallId
    && ends[0].allowed === true
    && ends[0].status === "ok";
  return {
    done: events.some((event) => event.type === "done"),
    hasText: text.trim().length > 0,
    errorEvents: events.filter((event) => event.type === "error").length,
    safeReadLifecycle: lifecycle,
    forbiddenControlEvents: events.filter((event) => FORBIDDEN_CONTROL_EVENTS.has(String(event.type))).length,
    readNonceSeen: text.includes(READ_NONCE),
    continuityMarkerSeen: text.includes(MARKER),
  };
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
