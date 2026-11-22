// ── Credential Redaction ──
// Masks secrets in tool output before they reach the LLM/chat.
// Pattern catalog lives in credential-patterns.ts — add new shapes there.

import type { ServerEvent } from "../../types.js";
import { CREDENTIAL_KEY_PATTERNS, redact } from "./credential-patterns.js";

/** Redact potential credentials from a string before it reaches chat/LLM. */
export function redactCredentials(text: string): string {
  return redact(text);
}

/** Every string inside a tool's args, redacted; the shape is kept. */
function redactLeaves(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactLeaves);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactLeaves(v)]));
  }
  return value;
}

/** A chat event as a client may see it: the text it carries (stream and
 *  reasoning text, tool args, progress and results, error text) with credentials masked.
 *  The one step every transport sends through (SSE, the chat socket and its
 *  replay, and the phone relay riding that socket), so no client gets a
 *  credential another client would have had masked. */
export function redactEventCredentials(event: ServerEvent): ServerEvent {
  switch (event.type) {
    case "stream":
    case "reasoning":
      if ("delta" in event && event.delta) return { ...event, delta: redact(event.delta) };
      if ("text" in event && event.text) return { ...event, text: redact(event.text) };
      return event;
    case "tool_start":
      return { ...event, args: redactLeaves(event.args) };
    case "tool_progress":
      return event.message ? { ...event, message: redact(event.message) } : event;
    case "tool_end":
      return event.result ? { ...event, result: redact(event.result) } : event;
    // An error's text is whatever the failing layer said, and a provider or
    // tool can quote the request it refused.
    case "error":
      return event.message ? { ...event, message: redact(event.message) } : event;
    default:
      return event;
  }
}

export { CREDENTIAL_KEY_PATTERNS, redact };
