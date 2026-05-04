import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

import { createLogger } from "./logger.js";
const logger = createLogger("context-manager");

/**
 * Context Manager — Token tracking + auto-compaction
 *
 * Tracks token usage across the conversation and auto-compacts
 * when context gets full. Preserves current task state, todo lists,
 * and recent messages so the agent doesn't lose track mid-work.
 *
 * Thresholds:
 * - 70%: UI warning ("context getting full")
 * - 85%: Queue compact for next natural break
 * - 95%: Force compact now, keep working
 * - 100%: Emergency compact + retry
 */

// Model context windows (tokens)
const MODEL_CONTEXTS: Record<string, number> = {
  "gpt-5.3-codex": 128_000,
  "gpt-5.3-codex-spark": 128_000,
  "gpt-5.4": 272_000,        // Native 1.05M, default working 272k
  "gpt-5.4-mini": 272_000,
  "gpt-5.5": 1_000_000,
  "gpt-5.5-pro": 1_000_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "grok-3-mini": 131_072,
  "grok-3": 131_072,
  // Anthropic Claude 4.x family — 200k base window
  "claude-sonnet-4-5": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-sonnet-4-7": 200_000,
  "claude-opus-4-5": 200_000,
  "claude-opus-4-6": 200_000,
  "claude-opus-4-7": 1_000_000, // 4.7 ships with 1M context natively
  "claude-haiku-4-5": 200_000,
  // Anthropic Opus 4.6 with 1M context beta
  "claude-opus-4-6[1m]": 1_000_000,
  "claude-opus-4-7[1m]": 1_000_000,
  // Gemini 2.x family
  "gemini-2.0-flash": 1_000_000,
  "gemini-2.5-pro-preview-05-06": 1_000_000,
  "gemini-2.5-flash-preview-05-20": 1_000_000,
};
function lookupContextWindow(model: string): number {
  if (MODEL_CONTEXTS[model]) return MODEL_CONTEXTS[model];
  const lower = model.toLowerCase();
  if (lower.includes("claude")) return 200_000;
  if (lower.includes("gemini")) return 1_000_000;
  if (lower.includes("gpt-5.5")) return 1_000_000;
  if (lower.includes("gpt-5.4")) return 272_000;
  if (lower.includes("gpt-4") || lower.includes("gpt-5") || lower.includes("o3")) return 128_000;
  if (lower.includes("grok")) return 131_072;
  return DEFAULT_CONTEXT;
}
// Ollama models typically have smaller context; use conservative default
const DEFAULT_CONTEXT = 128_000;

// ── Token estimation ──

/** Estimate token count for a string (~4 chars per token, rough but fast) */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5); // Slightly conservative
}

/** Estimate tokens for a single message (content + tool calls + role overhead) */
export function messageTokens(msg: ChatCompletionMessageParam): number {
  let tokens = 4; // Role + formatting overhead

  if (typeof msg.content === "string") {
    tokens += estimateTokens(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (typeof part === "object" && "text" in part) {
        tokens += estimateTokens(String(part.text));
      }
    }
  }

  // Tool calls in assistant messages
  const m = msg as unknown as Record<string, unknown>;
  if (m.tool_calls && Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls as Array<{ function?: { name?: string; arguments?: string } }>) {
      tokens += estimateTokens(tc.function?.name || "");
      tokens += estimateTokens(tc.function?.arguments || "");
      tokens += 10; // Tool call overhead
    }
  }

  return tokens;
}

/** Estimate total tokens for a message array */
export function totalTokens(messages: ChatCompletionMessageParam[]): number {
  return messages.reduce((sum, msg) => sum + messageTokens(msg), 0);
}

// ── Context status ──

export interface ContextStatus {
  usedTokens: number;
  maxTokens: number;
  percentage: number;
  level: "ok" | "warning" | "compact" | "critical" | "emergency";
  shouldCompact: boolean;
  forceCompact: boolean;
}

/**
 * Codex models (OpenAI gpt-5.x family) have a NOMINAL context window of up
 * to 1M tokens, but their PRACTICAL agentic performance degrades well before
 * that. We saw a 334k-token Codex turn end with "I'm missing the actual task
 * context" despite making real edits — the original task was buried under
 * tool results. Compact much earlier for Codex regardless of the nominal
 * window so the original user message stays anchored near the response
 * position. Anthropic models hold focus better and don't need this.
 */
function isCodexModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.startsWith("gpt-") || lower.includes("codex") || lower.startsWith("o1") || lower.startsWith("o3");
}

export function getContextStatus(
  messages: ChatCompletionMessageParam[],
  model: string
): ContextStatus {
  const maxTokens = lookupContextWindow(model);
  const usedTokens = totalTokens(messages);
  const percentage = Math.round((usedTokens / maxTokens) * 100);

  let level: ContextStatus["level"] = "ok";
  let shouldCompact = false;
  let forceCompact = false;

  // Per-provider thresholds. Codex compacts much earlier because its long-
  // context agentic reasoning falls apart before the nominal limit hits.
  // Anthropic keeps the previous (looser) thresholds since it stays focused.
  const isCodex = isCodexModel(model);
  const warningAt = isCodex ? 25 : 60;
  const compactAt = isCodex ? 35 : 75;
  const criticalAt = isCodex ? 55 : 90;

  if (percentage >= criticalAt) {
    level = "critical";
    forceCompact = true;
    shouldCompact = true;
  } else if (percentage >= compactAt) {
    level = "compact";
    shouldCompact = true;
  } else if (percentage >= warningAt) {
    level = "warning";
  }

  return { usedTokens, maxTokens, percentage, level, shouldCompact, forceCompact };
}

// ── Compaction ──

/** Extract any active todo/task list from recent messages */
function extractTaskState(messages: ChatCompletionMessageParam[]): string {
  const taskPatterns = [
    /(?:todo|task|checklist|plan|steps?)[\s:]*\n([\s\S]*?)(?:\n\n|\n(?=[A-Z]))/gi,
    /(?:working on|currently|in progress|next up)[\s:]+(.+)/gi,
    /\[(?:in_progress|pending|completed)\]\s+(.+)/gi,
  ];

  const tasks: string[] = [];

  // Check last 10 messages for task state
  for (const msg of messages.slice(-10)) {
    const content = typeof msg.content === "string" ? msg.content : "";
    for (const pattern of taskPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        tasks.push(match[0].trim());
      }
    }
  }

  return tasks.length > 0 ? `\nActive tasks/todo:\n${tasks.join("\n")}` : "";
}

/** Extract key facts and decisions from the conversation */
function extractKeyFacts(messages: ChatCompletionMessageParam[]): string[] {
  const facts: string[] = [];
  const patterns = [
    /(?:decided|agreed|confirmed|will|should|must|need to)\s+(.{10,80})/gi,
    /(?:the user wants|user asked|user said|user prefers)\s+(.{10,80})/gi,
    /(?:important|note|remember|key point)[\s:]+(.{10,80})/gi,
  ];

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const content = typeof msg.content === "string" ? msg.content : "";
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        facts.push(match[0].trim());
        if (facts.length >= 15) break; // Cap at 15 facts
      }
    }
  }

  return [...new Set(facts)]; // Deduplicate
}

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

  // Build summary of what we're compacting
  const oldContent = oldMessages.map(m => {
    const role = m.role;
    const content = typeof m.content === "string" ? m.content : "[non-text]";
    return `[${role}]: ${content.slice(0, 300)}`;
  }).join("\n");

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

// ── Context-overflow error detection ──
//
// Providers return very different error messages for "too many tokens":
//   OpenAI:    "context_length_exceeded" / "maximum context length"
//   Anthropic: "prompt is too long" / "input is too long"
//   Grok/xAI:  "maximum context length" / "too many tokens"
//   Gemini:    "exceeds the maximum" / "400 ... too long"
// This check is signature-based so callers can force-compact + retry instead
// of returning a hard error.

export function isContextOverflowError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("context_length_exceeded") ||
    msg.includes("maximum context length") ||
    msg.includes("context window") ||
    msg.includes("prompt is too long") ||
    msg.includes("input is too long") ||
    msg.includes("too many tokens") ||
    msg.includes("exceeds the maximum") ||
    msg.includes("token limit") ||
    msg.includes("max_tokens_exceeded") ||
    (msg.includes("400") && msg.includes("too long"))
  );
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
    const { classifyWithLLM } = await import("./classifiers/classify-with-llm.js");
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

const COMPACTION_SYSTEM_PROMPT = `You compact long conversation segments into a structured summary that the agent will use to continue working.

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
