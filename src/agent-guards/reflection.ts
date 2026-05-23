// Self-reflection guard. Scans recent tool results for unresolved errors —
// patterns like BLOCKED / failed / ENOENT — and surfaces them so the
// caller can inject a "[Self-check] ..." user prompt forcing the model to
// either acknowledge the failure or explain why it's irrelevant.
//
// Skips when the last assistant message already references error language
// (the model already self-corrected; another nudge would just spiral) and
// when a prior [Self-check] is in the recent window (don't double-nudge).

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

export function detectUnresolvedErrors(messages: ChatCompletionMessageParam[]): string[] {
  const recentMsgs = messages.slice(-20);
  for (const m of recentMsgs) {
    if (m.role === "user" && typeof m.content === "string" && m.content.startsWith("[Self-check]")) {
      return [];
    }
  }

  let lastAssistantTextIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && typeof m.content === "string" && m.content.trim().length > 0) {
      lastAssistantTextIdx = i;
      break;
    }
  }

  const errors: string[] = [];
  const startIdx = Math.max(lastAssistantTextIdx + 1, messages.length - 20);
  for (let i = startIdx; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    const c = m.content;
    if (/\b(BLOCKED|error|failed|timed? ?out|not found|permission denied|ENOENT|EACCES|EPERM)\b/i.test(c) && c.length < 500) {
      errors.push(c.slice(0, 200));
    }
  }

  const lastAssistant = [...recentMsgs].reverse().find(m => m.role === "assistant" && typeof m.content === "string");
  if (errors.length > 0 && lastAssistant && typeof lastAssistant.content === "string") {
    if (/\b(error|failed|couldn't|unable|issue|problem|unfortunately|sorry|block(ed)?|denied|skip(ped)?|switch(ed)?|tried|moved on|gave up|cannot|can't|workaround|alternative|instead|fallback|repeat)\b/i.test(lastAssistant.content)) {
      return [];
    }
  }
  return errors;
}

export function buildReflectionPrompt(errors: string[]): string {
  return `[Self-check] The following tool errors occurred but may not have been addressed in your response. If any are relevant to the user's request, briefly acknowledge what went wrong and suggest a fix. If they're irrelevant (e.g., optional lookups), ignore them.\n\nErrors:\n${errors.map((e, i) => `${i + 1}. ${e}`).join("\n")}`;
}
