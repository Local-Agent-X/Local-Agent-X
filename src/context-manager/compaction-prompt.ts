import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

import { extractKeyFacts, extractTaskState } from "./compaction-extractors.js";

export const COMPACTION_SYSTEM_PROMPT = `You compact long conversation segments into a structured summary that the agent will use to continue working.

Output a tight summary covering exactly these sections (skip a section if empty):

DECISIONS: bullet list of choices the user explicitly made or approved (technologies, file locations, model choices, etc).
CONSTRAINTS: bullet list of "must do" / "must not do" rules the user stated. Preserve every "do NOT use X", "always Y", "must support Z". This is the highest-priority section — never drop a constraint.
FACTS_ABOUT_USER: bullet list of durable user facts mentioned (preferences, projects they own, tools they use). Skip transient mood.
OUTSTANDING_ASKS: bullet list of work the user requested that wasn't yet completed.
CURRENT_TASK_STATE: one paragraph — what is the agent in the middle of doing right now?

Rules:
- Quote user constraints near-verbatim — phrasing matters ("don't use X" vs "avoid X" can differ).
- Skip filler like "you said hi, agent said hi back".
- Skip tool call mechanics — only what they accomplished.
- No preamble, no closing remarks. Start with the first section header.
- If the segment is genuinely empty of decisions/constraints/asks, reply with the single line: NOTHING_NOTABLE.`;

/**
 * Build the compaction summary prompt.
 * This asks the LLM to summarize the conversation, preserving critical context.
 */
export function buildCompactionPrompt(
  messages: ChatCompletionMessageParam[],
  keepLast: number = 6
): { summary: string; keptMessages: ChatCompletionMessageParam[] } {
  if (messages.length <= keepLast + 2) {
    // Not enough to compact
    return { summary: "", keptMessages: messages };
  }

  // Split: old messages to summarize, recent messages to keep
  // CRITICAL: always preserve the last user message — it's what the user just said
  const systemMsgs = messages.filter(m => m.role === "system");
  const nonSystem = messages.filter(m => m.role !== "system");
  const oldMessages = nonSystem.slice(0, -keepLast);
  let recentMessages = nonSystem.slice(-keepLast);
  // Ensure the very last user message is always included (but don't duplicate)
  const lastUserIdx = nonSystem.findLastIndex(m => m.role === "user");
  if (lastUserIdx >= 0 && lastUserIdx < nonSystem.length - keepLast) {
    // The last user message got compacted out — force include it at the front
    // Only add if not already in recentMessages (avoid duplicates)
    if (!recentMessages.includes(nonSystem[lastUserIdx])) {
      recentMessages = [nonSystem[lastUserIdx], ...recentMessages];
    }
  }

  // Extract task state and key facts before discarding
  const taskState = extractTaskState(messages);
  const keyFacts = extractKeyFacts(oldMessages);


  const summary =
    `[CONVERSATION SUMMARY — auto-compacted to save context]\n` +
    `This conversation has been automatically summarized to free up context space.\n` +
    `Messages summarized: ${oldMessages.length}\n` +
    `${keyFacts.length > 0 ? `\nKey decisions/facts from earlier:\n${keyFacts.map(f => `- ${f}`).join("\n")}` : ""}` +
    `${taskState}` +
    `\nThe ${recentMessages.length} most recent messages are preserved in full below.\n` +
    `Continue the conversation naturally — the user should not notice the compaction.`;

  const keptMessages = [
    ...systemMsgs,
    { role: "system" as const, content: summary },
    ...recentMessages,
  ];

  return { summary, keptMessages };
}

/**
 * Aggressive compaction for context-overflow recovery. Keeps system messages
 * and the last few exchanges; summarizes everything else.
 */
export function forceCompact(
  messages: ChatCompletionMessageParam[],
  keepLast: number = 2,
): ChatCompletionMessageParam[] {
  const { keptMessages } = buildCompactionPrompt(messages, keepLast);
  return keptMessages;
}
