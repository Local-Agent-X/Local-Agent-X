import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

import { compactIfNeededWithLLM } from "../../context-manager/compaction.js";
import { jsonResponse, safeParseBody } from "../../server-utils.js";

/**
 * Handle POST /api/eval/compact. Eval-only pass-through that runs the REAL
 * canonical `compactIfNeededWithLLM` on a caller-supplied transcript and
 * returns the compacted text, so an eval runner can measure how much of the
 * original facts survive summarization. Deliberately not a second compaction
 * implementation — fidelity only counts if we exercise the production path.
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
  const body = (raw ?? {}) as { messages?: unknown; model?: string; force?: boolean };
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    jsonResponse(res, 400, { error: "messages must be a non-empty array" }, req);
    return true;
  }

  const messages = body.messages as ChatCompletionMessageParam[];
  const model = typeof body.model === "string" && body.model ? body.model : "claude-sonnet-4-6";
  const force = body.force !== false;

  const result = await compactIfNeededWithLLM(messages, model, force);

  // content may be multimodal parts, not a plain string — stringify defensively.
  const text = result.messages
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");

  jsonResponse(res, 200, {
    compacted: result.compacted,
    summarizedByLLM: result.summarizedByLLM,
    before: messages.length,
    after: result.messages.length,
    percent: result.status.percentage,
    text,
  }, req);
  return true;
}
