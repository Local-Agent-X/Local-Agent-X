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
 * Calls Anthropic Haiku with the same auth path the auto-delegate
 * classifier uses. Returns null on any failure — caller treats null as
 * MAIN_AGENT (safer default — never silently divert a user's message
 * to the worker if we're not confident).
 */

import { createLogger } from "../logger.js";
import { loadAnthropicTokens, isAnthropicTokenExpired } from "../auth-anthropic.js";

const logger = createLogger("routing.worker-redirect-classifier");

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

When in doubt, choose MAIN_AGENT. False redirects are far worse than false main-agent calls — diverting a real question to a worker means the user gets no answer.

Reply with EXACTLY one line in this format:
DECISION: <REDIRECT|MAIN_AGENT>
REASON: <one short sentence>

Nothing else.`;

/**
 * Classify a single user message in the context of an active worker.
 * `workerTask` is the original task the worker was given (if known) so
 * the model has context about what the worker is doing.
 */
export async function classifyWorkerRedirect(
  message: string,
  workerTask: string | undefined,
  signal?: AbortSignal,
): Promise<WorkerRedirectResult | null> {
  // Trivially short messages can't really be feedback worth routing.
  // (One-word "yes"/"ok"/"thanks" should go to main agent.)
  if (message.trim().length < 3) {
    return { redirect: false, reason: "message too short to be redirect-worthy", raw: "(skipped)" };
  }
  // Very long messages are almost never worker feedback — they're new
  // turns or detailed asks. Skip the LLM call.
  if (message.length > 2000) {
    return { redirect: false, reason: "message too long to be redirect feedback", raw: "(skipped)" };
  }

  const tokens = loadAnthropicTokens();
  if (!tokens || isAnthropicTokenExpired(tokens)) return null;
  const accessToken = tokens.accessToken || "";
  if (!accessToken) return null;

  const userPrompt = workerTask
    ? `Worker is currently working on: ${workerTask.slice(0, 200)}\n\nUser's new message: ${message}`
    : `(Worker task unknown — judge by the message alone.)\n\nUser's new message: ${message}`;

  try {
    const { streamAnthropicResponse } = await import("../anthropic-client.js");
    const stream = streamAnthropicResponse({
      token: accessToken,
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: userPrompt } as never],
      systemPrompt: SYSTEM_PROMPT,
      temperature: 0,
      signal,
    });

    let response = "";
    for await (const event of stream) {
      if (event.type === "text") response += event.delta || "";
      if (response.length > 500) break;
    }

    const decisionMatch = response.match(/DECISION:\s*(REDIRECT|MAIN_AGENT)/i);
    const reasonMatch = response.match(/REASON:\s*(.+?)$/im);
    if (!decisionMatch) {
      logger.warn(`couldn't parse classifier response: "${response.slice(0, 200)}"`);
      return null;
    }
    return {
      redirect: decisionMatch[1].toUpperCase() === "REDIRECT",
      reason: reasonMatch?.[1].trim() || "(no reason given)",
      raw: response,
    };
  } catch (e) {
    logger.warn(`classifier call failed: ${(e as Error).message}`);
    return null;
  }
}
