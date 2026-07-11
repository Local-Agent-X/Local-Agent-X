// ── Credential Redaction ──
// Masks secrets in tool output before they reach the LLM/chat.
// Pattern catalog lives in credential-patterns.ts — add new shapes there.

import { CREDENTIAL_KEY_PATTERNS, redact } from "./credential-patterns.js";

/** Redact potential credentials from a string before it reaches chat/LLM. */
export function redactCredentials(text: string): string {
  return redact(text);
}

export { CREDENTIAL_KEY_PATTERNS, redact };
