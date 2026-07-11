import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

import { summarizeOldMessages } from "../../context-manager/compaction.js";
import { getContextStatus } from "../../context-manager/status.js";
import { jsonResponse, safeParseBody } from "../../server-utils.js";

/**
 * Handle POST /api/eval/compact. Eval-only pass-through that runs the REAL
 * production compaction primitive (`summarizeOldMessages` — the same call the
 * canonical loop's compact-history and the chat-lane digest use) on a
 * caller-supplied transcript, so an eval runner can measure how much of the
 * original facts survive summarization. Mirrors production shape: head is
 * summarized, tail kept verbatim, summary prepended as a system message.
 *
 * Returns `true` if the request was handled.
 */
export async function handleEvalCompactRoute(
  method: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!(method === "POST" && url.pathname === "/api/eval/compact")) return false;

  const raw = await safeParseBody(req);
  const body = (raw ?? {}) as { messages?: unknown; model?: string; keepLast?: number };
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    jsonResponse(res, 400, { error: "messages must be a non-empty array" }, req);
    return true;
  }

  const messages = body.messages as ChatCompletionMessageParam[];
  const model = typeof body.model === "string" && body.model ? body.model : "claude-sonnet-5";
  const keepLast = typeof body.keepLast === "number" && body.keepLast > 0 ? body.keepLast : 6;

  const systemMsgs = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");
  const oldMessages = nonSystem.slice(0, -keepLast);
  const recentMessages = nonSystem.slice(-keepLast);

  const summary = oldMessages.length > 0 ? await summarizeOldMessages(oldMessages) : null;

  const compacted: ChatCompletionMessageParam[] = summary
    ? [
        ...systemMsgs,
        {
          role: "system",
          content:
            `[CONVERSATION SUMMARY — auto-compacted via LLM to save context]\n` +
            `Messages summarized: ${oldMessages.length}\n\n` +
            summary +
            `\n\nThe ${recentMessages.length} most recent messages are preserved verbatim below. ` +
            `Continue the conversation naturally.`,
        },
        ...recentMessages,
      ]
    : messages;

  // content may be multimodal parts, not a plain string — stringify defensively.
  const text = compacted
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");

  jsonResponse(res, 200, {
    compacted: summary !== null,
    summarizedByLLM: summary !== null,
    before: messages.length,
    after: compacted.length,
    percent: getContextStatus(compacted, model).percentage,
    text,
  }, req);
  return true;
}
