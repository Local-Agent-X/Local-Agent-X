import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

import { createLogger } from "../logger.js";
import { stripHarnessMarkers } from "../harness-text.js";
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
  const transcript = buildSummaryTranscript(oldMessages);

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
    //
    // Live guard branches AT THIS SEAM: only the loop detectors can fire.
    // classifyWithLLM's parse below already maps whitespace-only output to
    // null (→ the transport-null path, not the guard's empty branch), and
    // maxResponseChars 6000 makes a >10k-char line unreachable. Both branches
    // stay in the guard because it is a shared primitive — other seams have
    // different parse/limit envelopes.
    const summary = await guardedRewrite(
      (_attempt, feedback) =>
        classifyWithLLM<string>({
          category: "compaction",
          role: "review",
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
      { maxAttempts: 2, validate: (text) => summaryRejection(text, oldMessages) },
    );
    // guardedRewrite falls back to a candidate that failed only `validate`;
    // a transcript echo, or "nothing notable" over real work, is never usable,
    // so it takes the null path instead (the caller then keeps the longest
    // tail that fits rather than injecting a summary that says nothing).
    return summary !== null && summaryRejection(summary, oldMessages) === null ? summary : null;
  } catch (e) {
    logger.warn(`[context] LLM compaction call failed: ${(e as Error).message}`);
    return null;
  }
}

// Transcript size bound. Local summaries run through dispatch at
// DISPATCH_NUM_CTX (16,384 tokens, local-runtimes/residency.ts), and Ollama silently
// truncates an over-long prompt from the FRONT, dropping the instructions
// above. The model then continues the conversation instead of summarizing
// (reproduced 2026-09-14: a ~42k-token head of browser snapshots came back as
// "Now I'll archive the selected items. [called browser(...)]", which was
// injected as the summary and derailed the next turns). 30k chars stays near
// 10k tokens even for dense snapshot text, leaving room for the system prompt
// and the 6000-char reply.
const SUMMARY_TRANSCRIPT_CHAR_BUDGET = 30_000;
// Tool results only need "what they accomplished" (the prompt says so); user
// rows carry the constraints the summary must never drop, so they keep the most.
const SUMMARY_CHARS_PER_KIND = { user: 2000, assistant: 800, tool: 400 } as const;

function messageText(m: ChatCompletionMessageParam): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((p) => typeof p === "object" && "text" in p)
      .map((p) => String((p as { text: string }).text))
      .join(" ");
  }
  return "[non-text]";
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} chars clipped]` : text;
}

/** Bounded `[role]: text` transcript. Tool results (role "tool", or the
 *  canonical loop's "[tool result]"-prefixed user rows) are clipped hardest; if
 *  it still exceeds the budget, the oldest non-user rows are dropped first and
 *  user rows only after those run out.
 *
 *  A tool row's framing is dropped before the clip so the budget buys the
 *  tool's OUTPUT. memory_search wraps its hits in ~480 characters of harness
 *  instruction, which is longer than a tool row's whole allowance: the clip
 *  kept the envelope and cut every retrieved value, leaving a summary that
 *  read like the search had returned nothing (2026-09-23). Framing the
 *  harness wrote tells a summarizer nothing it needs. */
export function buildSummaryTranscript(messages: ChatCompletionMessageParam[]): string {
  const rows = messages.map((m) => {
    const text = messageText(m);
    const kind = m.role === "tool" || text.startsWith("[tool result]") ? "tool" : m.role === "user" ? "user" : "assistant";
    const body = kind === "tool" ? stripHarnessMarkers(text).trim() : text;
    return { line: `[${m.role}]: ${clip(body, SUMMARY_CHARS_PER_KIND[kind])}`, isUser: kind === "user", dropped: false };
  });
  let total = rows.reduce((sum, r) => sum + r.line.length + 2, 0);
  for (const dropUsers of [false, true]) {
    for (const row of rows) {
      if (total <= SUMMARY_TRANSCRIPT_CHAR_BUDGET) break;
      if (row.dropped || row.isUser !== dropUsers) continue;
      row.dropped = true;
      total -= row.line.length + 2;
    }
  }
  const omitted = rows.filter((r) => r.dropped).length;
  const kept = rows.filter((r) => !r.dropped).map((r) => r.line);
  if (omitted > 0) kept.unshift(`[${omitted} older messages omitted to fit the summarizer's context]`);
  return kept.join("\n\n");
}

// A summary never needs the transcript's own markup; seeing it means the model
// continued the conversation instead of summarizing it.
const TRANSCRIPT_MARKUP = /\[called [\w.-]+\(|\[tool result\]|^\[(user|assistant|tool|system)\]:/m;

/**
 * Substance: the segment holds work a summary must carry. muse answered
 * NOTHING_NOTABLE for 56 messages of file reads, test runs and its own
 * analysis of a failing suite (2026-09-17), and that one word replaced ~8,900
 * tokens of history — which is why the model then re-read the same files up to
 * 30 times in a run. The escape hatch is for a genuinely empty stretch.
 */
const SUBSTANCE_MIN_MESSAGES = 6;
const SUBSTANCE_MIN_WORK_ROWS = 3;
/** A row that carries work: a tool call, its result, or a substantial answer. */
const WORK_ROW = /\[called [\w.-]+\(|\[tool result\]/;

function hasSubstance(messages: ChatCompletionMessageParam[]): boolean {
  if (messages.length < SUBSTANCE_MIN_MESSAGES) return false;
  const work = messages.filter((m) => {
    const text = typeof m.content === "string" ? m.content : "";
    return WORK_ROW.test(text) || text.length > 200;
  });
  return work.length >= SUBSTANCE_MIN_WORK_ROWS;
}

/** Why this summary is unusable, or null when it stands. */
function summaryRejection(text: string, messages: ChatCompletionMessageParam[]): string | null {
  if (/^\s*NOTHING_NOTABLE\s*$/i.test(text) && hasSubstance(messages)) {
    return `the segment is ${messages.length} messages of real work (file reads, commands, results) — summarize what was decided, what is still outstanding, and what you were in the middle of`;
  }
  return transcriptEchoError(text);
}

function transcriptEchoError(text: string): string | null {
  return TRANSCRIPT_MARKUP.test(text)
    ? "it continued the conversation (tool-call or role markup) instead of summarizing it"
    : null;
}
