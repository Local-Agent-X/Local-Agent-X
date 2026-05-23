import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

import { createLogger } from "../logger.js";
import { buildCompactionPrompt, COMPACTION_SYSTEM_PROMPT } from "./compaction-prompt.js";
import { getContextStatus, type ContextStatus } from "./status.js";

const logger = createLogger("context-manager");

/**
 * Compact messages if needed. Returns compacted messages or original if no compaction needed.
 *
 * SYNCHRONOUS path — uses string truncation. Kept as a fallback. New callers
 * should prefer `compactIfNeededWithLLM` when they're already in an async
 * context, because truncation silently drops constraints in the middle of
 * long messages ("build X, do NOT use Y, must support Z" → "build X, do").
 */
export function compactIfNeeded(
  messages: ChatCompletionMessageParam[],
  model: string,
  force: boolean = false
): {
  messages: ChatCompletionMessageParam[];
  compacted: boolean;
  status: ContextStatus;
} {
  const status = getContextStatus(messages, model);

  if (!force && !status.shouldCompact) {
    return { messages, compacted: false, status };
  }

  // Determine how many recent messages to keep
  // More aggressive compaction at higher thresholds
  let keepLast = 6;
  if (status.percentage >= 95) keepLast = 4;
  if (status.percentage >= 99) keepLast = 2;

  const { keptMessages } = buildCompactionPrompt(messages, keepLast);
  const newStatus = getContextStatus(keptMessages, model);

  logger.info(
    `[context] Compacted: ${messages.length} msgs (${status.percentage}%) → ${keptMessages.length} msgs (${newStatus.percentage}%)`
  );

  return {
    messages: keptMessages,
    compacted: true,
    status: newStatus,
  };
}

/**
 * Compact messages using a real LLM summarization call. Preferred over the
 * sync `compactIfNeeded` because it preserves constraints, decisions, facts,
 * and outstanding asks rather than slicing at 300 chars per message.
 *
 * Falls back to the sync truncation path if the LLM call fails (no auth,
 * network blip, timeout) so compaction never blocks the agent loop.
 */
export async function compactIfNeededWithLLM(
  messages: ChatCompletionMessageParam[],
  model: string,
  force: boolean = false,
): Promise<{
  messages: ChatCompletionMessageParam[];
  compacted: boolean;
  status: ContextStatus;
  summarizedByLLM: boolean;
}> {
  const status = getContextStatus(messages, model);
  if (!force && !status.shouldCompact) {
    return { messages, compacted: false, status, summarizedByLLM: false };
  }

  let keepLast = 6;
  if (status.percentage >= 95) keepLast = 4;
  if (status.percentage >= 99) keepLast = 2;

  const systemMsgs = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");
  if (nonSystem.length <= keepLast + 2) {
    return { messages, compacted: false, status, summarizedByLLM: false };
  }
  const oldMessages = nonSystem.slice(0, -keepLast);
  let recentMessages = nonSystem.slice(-keepLast);
  const lastUserIdx = nonSystem.findLastIndex((m) => m.role === "user");
  if (
    lastUserIdx >= 0 &&
    lastUserIdx < nonSystem.length - keepLast &&
    !recentMessages.includes(nonSystem[lastUserIdx])
  ) {
    recentMessages = [nonSystem[lastUserIdx], ...recentMessages];
  }

  const transcript = oldMessages
    .map((m) => {
      const role = m.role;
      const content = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .filter((p) => typeof p === "object" && "text" in p)
              .map((p) => String((p as { text: string }).text))
              .join(" ")
          : "[non-text]";
      return `[${role}]: ${content}`;
    })
    .join("\n\n");

  let summary: string | null = null;
  try {
    const { classifyWithLLM } = await import("../classifiers/classify-with-llm.js");
    summary = await classifyWithLLM<string>({
      category: "compaction",
      systemPrompt: COMPACTION_SYSTEM_PROMPT,
      userPrompt: `Conversation segment to summarize (${oldMessages.length} messages):\n\n${transcript}`,
      timeoutMs: 30_000,
      maxResponseChars: 6000,
      envDisableVar: "LAX_LLM_COMPACTION",
      parse: (raw) => {
        const trimmed = raw.trim();
        return trimmed.length > 0 ? trimmed : null;
      },
    });
  } catch (e) {
    logger.warn(`[context] LLM compaction call failed: ${(e as Error).message}`);
  }

  if (!summary) {
    // Fallback: sync truncation path so the agent loop never stalls.
    const { keptMessages } = buildCompactionPrompt(messages, keepLast);
    const newStatus = getContextStatus(keptMessages, model);
    logger.info(
      `[context] Compacted (truncation fallback): ${messages.length} → ${keptMessages.length} msgs`,
    );
    return { messages: keptMessages, compacted: true, status: newStatus, summarizedByLLM: false };
  }

  const summaryMsg: ChatCompletionMessageParam = {
    role: "system",
    content:
      `[CONVERSATION SUMMARY — auto-compacted via LLM to save context]\n` +
      `Messages summarized: ${oldMessages.length}\n\n` +
      summary +
      `\n\nThe ${recentMessages.length} most recent messages are preserved verbatim below. ` +
      `Continue the conversation naturally.`,
  };

  const keptMessages = [...systemMsgs, summaryMsg, ...recentMessages];
  const newStatus = getContextStatus(keptMessages, model);
  logger.info(
    `[context] Compacted (LLM summary): ${messages.length} msgs (${status.percentage}%) → ${keptMessages.length} msgs (${newStatus.percentage}%)`,
  );
  return { messages: keptMessages, compacted: true, status: newStatus, summarizedByLLM: true };
}
