// Lightweight evidence model: count tool results that look like they
// advanced the state. Read operations, searches, lists, and any writes.
// Dead-ends and empty results don't count.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

const EVIDENCE_TOOLS = new Set([
  "read", "bash", "list_files", "ls", "search", "find", "grep", "glob",
  "web_fetch", "web_search", "write", "edit", "http_request",
  "browser",
]);

/**
 * Scan turn messages for evidence-generating tool calls with non-empty
 * results. Returns a count. Caller diffs this across iterations to detect
 * staleness.
 */
export function computeEvidenceCount(messages: ChatCompletionMessageParam[]): number {
  let count = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const tcs = (m as unknown as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls;
    if (!tcs) continue;
    for (const tc of tcs) {
      const name = tc.function?.name || "";
      if (!EVIDENCE_TOOLS.has(name)) continue;
      count += 1;
    }
  }
  return count;
}
