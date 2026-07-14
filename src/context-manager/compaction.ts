import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

import { createLogger } from "../logger.js";
import { guardedRewrite } from "./llm-rewrite-guard.js";

const logger = createLogger("context-manager");

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
 * Summarize a segment of older messages into a structured digest via the user's
 * configured provider (no new API key — routes through classifyWithLLM). Returns
 * null when the call is disabled (LAX_LLM_COMPACTION), times out, or fails, so
 * callers can fall back without ever blocking the loop. This is THE compaction
 * primitive — consumed by the canonical loop's history compaction
 * (turn-loop/compact-history.ts), the chat-lane digest (providers/sanitize.ts),
 * and the /api/compact route.
 */
export async function summarizeOldMessages(
  oldMessages: ChatCompletionMessageParam[],
): Promise<string | null> {
  const transcript = oldMessages
    .map((m) => {
      const content = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .filter((p) => typeof p === "object" && "text" in p)
              .map((p) => String((p as { text: string }).text))
              .join(" ")
          : "[non-text]";
      return `[${m.role}]: ${content}`;
    })
    .join("\n\n");

  const basePrompt = `Conversation segment to summarize (${oldMessages.length} messages):\n\n${transcript}`;

  try {
    const { classifyWithLLM } = await import("../classifiers/classify-with-llm.js");
    // guardedRewrite screens each attempt for degenerate output (looping
    // text, runaway lines, emptiness) and gives the model ONE structured
    // retry with the rejection reason before surfacing null — which callers
    // already treat as a summarize failure (compact-history feeds it into the
    // circuit breaker). Transport-level nulls (kill-switch, 30s timeout,
    // provider error) short-circuit inside guardedRewrite without a retry, so
    // the existing latency and kill-switch behavior is unchanged.
    return await guardedRewrite(
      (_attempt, feedback) =>
        classifyWithLLM<string>({
          category: "compaction",
          systemPrompt: COMPACTION_SYSTEM_PROMPT,
          userPrompt: feedback
            ? `${basePrompt}\n\nYour previous summary was rejected: ${feedback}. Produce a corrected summary following the same section rules.`
            : basePrompt,
          timeoutMs: 30_000,
          maxResponseChars: 6000,
          envDisableVar: "LAX_LLM_COMPACTION",
          parse: (raw) => {
            const trimmed = raw.trim();
            return trimmed.length > 0 ? trimmed : null;
          },
        }),
      { maxAttempts: 2 },
    );
  } catch (e) {
    logger.warn(`[context] LLM compaction call failed: ${(e as Error).message}`);
    return null;
  }
}
