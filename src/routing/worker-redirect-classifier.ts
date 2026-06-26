/**
 * Worker-redirect classifier — Step 2 of JARVIS-mode routing.
 *
 * When the user sends a chat message AND a background worker is already
 * running for that session, this decides where the message should go:
 *
 *   REDIRECT     — message is feedback/correction/instruction aimed at
 *                  the active worker ("make it blue", "use orange not
 *                  red", "add a contact form"). Routed to the worker
 *                  via redirectOp() — worker hears it on its next safe
 *                  iteration boundary and adjusts.
 *
 *   MAIN_AGENT   — message is unrelated chat, a status query, or a new
 *                  request entirely ("what's the weather", "how's it
 *                  going", "btw can you also..."). Falls through to
 *                  the normal chat flow — main agent answers in its
 *                  own bubble while the worker keeps working.
 *
 * Prompt is intentionally narrow — only two outputs. Status queries
 * count as MAIN_AGENT because the main agent SEES the worker's
 * progress trace and can answer without disturbing the worker.
 *
 * Routes through the canonical classifier wrapper (classifyWithLLM): runs on
 * the user's provider + background model, no hardcoded model, works for every
 * provider — not Anthropic-only. Returns null on any failure — caller treats
 * null as MAIN_AGENT (safer default — never silently divert a user's message
 * to the worker if we're not confident).
 */

import { classifyWithLLM } from "../classifiers/classify-with-llm.js";

export interface WorkerRedirectResult {
  /** True if message should silently go to the worker as a redirect. */
  redirect: boolean;
  /** One-sentence model rationale (for logs + telemetry). */
  reason: string;
  /** Raw model output, for debugging. */
  raw: string;
}

const SYSTEM_PROMPT = `You are a routing classifier. A background worker is currently running a task for the user. The user just sent a new chat message. Decide whether the new message should:

(A) REDIRECT — be silently forwarded to the worker as a course-correction. Use this when the message is clearly feedback/instructions about the work-in-progress: corrections ("make it blue", "use orange instead"), additions ("also add a contact form", "include pricing"), revisions ("rename it to X", "drop the FAQ section"), constraints ("keep it under 1 page", "no animations"). The user is talking ABOUT the active task.

(B) MAIN_AGENT — be handled by the main chat agent (worker is untouched). Use this for: unrelated questions ("what's the weather", "explain Y"), status queries ("how's it going", "what are you doing", "is it done"), new requests on a different topic, conversational chit-chat, or when intent is ambiguous. The user is NOT specifically directing the worker.

If "Recent main-agent chat" is provided, use it: a short or ambiguous reply ("yes", "ok", "3", "the second one", "do it") that is clearly an answer to a question the MAIN agent just asked is MAIN_AGENT — not a worker redirect. The worker has its own context and won't understand answers meant for the main chat.

When in doubt, choose MAIN_AGENT. False redirects are far worse than false main-agent calls — diverting a real question to a worker means the user gets no answer.

Reply with EXACTLY one line in this format:
DECISION: <REDIRECT|MAIN_AGENT>
REASON: <one short sentence>

Nothing else.`;

export interface RecentTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Classify a single user message in the context of an active worker.
 * `workerTask` is the original task the worker was given (if known) so
 * the model has context about what the worker is doing.
 *
 * `recentTurns` is the last few main-agent turns. Critical for short
 * replies: a "yes" answering the main agent's last question must NOT be
 * routed to the worker. Without this, the classifier sees only the message
 * string and the worker task — it has no way to know the user is replying to
 * a different agent.
 */
export async function classifyWorkerRedirect(
  message: string,
  workerTask: string | undefined,
  recentTurns: RecentTurn[] = [],
  signal?: AbortSignal,
): Promise<WorkerRedirectResult | null> {
  // Trivially short messages can't really be feedback worth routing.
  // "yes"/"yep"/"yeah"/"sure"/"ok"/"3"/"no" answering the main agent's
  // question always belong in MAIN_AGENT — the worker has its own context
  // and won't understand the answer. Threshold 5 covers single-word
  // confirmations and menu picks ("3.") without burning a Haiku call.
  if (message.trim().length < 5) {
    return { redirect: false, reason: "message too short — short confirmations go to main agent", raw: "(skipped)" };
  }
  // Very long messages are almost never worker feedback — they're new
  // turns or detailed asks. Skip the LLM call.
  if (message.length > 2000) {
    return { redirect: false, reason: "message too long to be redirect feedback", raw: "(skipped)" };
  }

  // Format the last few main-agent turns (most recent last). Cap each
  // turn at 400 chars and the whole block at the last 4 entries — enough
  // signal for "the main agent just asked X" without bloating the prompt.
  const recentBlock = recentTurns.length > 0
    ? "Recent main-agent chat (most recent last):\n"
      + recentTurns
        .slice(-4)
        .map(t => `${t.role.toUpperCase()}: ${t.content.slice(0, 400).replace(/\s+/g, " ").trim()}`)
        .join("\n\n")
      + "\n\n"
    : "";

  const userPrompt = workerTask
    ? `${recentBlock}Worker is currently working on: ${workerTask.slice(0, 200)}\n\nUser's new message: ${message}`
    : `${recentBlock}(Worker task unknown — judge by the message alone.)\n\nUser's new message: ${message}`;

  return classifyWithLLM<WorkerRedirectResult>({
    category: "worker-redirect",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    parse: parseWorkerRedirect,
    timeoutMs: 3000,
    maxResponseChars: 500,
    signal,
  });
}

export function parseWorkerRedirect(raw: string): WorkerRedirectResult | null {
  const decisionMatch = raw.match(/DECISION:\s*(REDIRECT|MAIN_AGENT)/i);
  if (!decisionMatch) return null;
  const reasonMatch = raw.match(/REASON:\s*(.+?)$/im);
  return {
    redirect: decisionMatch[1].toUpperCase() === "REDIRECT",
    reason: reasonMatch?.[1].trim() || "(no reason given)",
    raw,
  };
}
