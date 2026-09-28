/**
 * Ollama native /api/chat NDJSON stream -> normalized StreamChunks.
 *
 * Each line is one api.ChatResponse (api/types.go lines 519-564): a message
 * delta (`content`, `thinking`, complete `tool_calls`), and on the last line
 * `done: true` with `done_reason` and the Metrics (prompt_eval_count,
 * prompt_eval_cached_count, eval_count). A failure mid-stream arrives as a
 * line `{"error": "...", "status": N}` (server/routes.go ChatHandler,
 * lines 2937-2946).
 *
 * Tool calls arrive whole, never as argument deltas, and older runtimes send
 * them without an id. Pairing a tool result with its call, the orphan-result
 * repair and the turn trace all key on a string id, so every call gets one:
 * the runtime's own when present and unique in this response, else a
 * synthesized `call_<hex>`. Ids use only [A-Za-z0-9_-] (the strictest
 * provider pattern, Anthropic's tool_use id) so the history replays on any
 * provider after a mid-chat switch.
 */
import { randomBytes } from "node:crypto";
import type { StreamChunk } from "../adapter/types.js";

interface ChatLine {
  message?: {
    content?: unknown;
    thinking?: unknown;
    tool_calls?: Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }>;
  };
  done?: unknown;
  done_reason?: unknown;
  prompt_eval_count?: unknown;
  prompt_eval_cached_count?: unknown;
  eval_count?: unknown;
  error?: unknown;
  status?: unknown;
}

async function* ndjsonLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) yield line;
      }
    }
    const tail = (buf + decoder.decode()).trim();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

export function synthesizeToolCallId(): string {
  return `call_${randomBytes(9).toString("hex")}`;
}

/**
 * Parse one /api/chat stream. Yields text/thinking deltas as they arrive and
 * the tool calls, usage and done at the end — the order openai-http yields
 * them in, so the canonical stream loop is transport-blind.
 */
export async function* parseOllamaChatStream(
  body: ReadableStream<Uint8Array>,
  opts: { signal?: AbortSignal; startedAt: number },
): AsyncIterable<StreamChunk> {
  const calls: Array<{ id: string; name: string; arguments: string }> = [];
  const seenIds = new Set<string>();
  let stopReason = "end_turn";
  let firstTokenMs: number | undefined;
  let usage: { promptTokens: number; completionTokens: number; cachedTokens?: number } | null = null;

  for await (const raw of ndjsonLines(body)) {
    if (opts.signal?.aborted) { stopReason = "abort"; break; }
    let line: ChatLine;
    try { line = JSON.parse(raw) as ChatLine; } catch { continue; } // a torn line carries nothing we can use
    if (typeof line.error === "string") {
      const status = count(line.status);
      yield { type: "error", message: status ? `${status} ${line.error}` : line.error, ...(status ? { statusCode: status } : {}) };
      return;
    }
    const msg = line.message;
    const content = typeof msg?.content === "string" ? msg.content : "";
    const thinking = typeof msg?.thinking === "string" ? msg.thinking : "";
    const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
    if (firstTokenMs === undefined && (content || thinking || toolCalls.length > 0)) firstTokenMs = Date.now() - opts.startedAt;
    if (content) yield { type: "text", delta: content };
    if (thinking) yield { type: "thinking", delta: thinking };
    for (const tc of toolCalls) {
      const given = typeof tc.id === "string" && /^[A-Za-z0-9_-]+$/.test(tc.id) && !seenIds.has(tc.id) ? tc.id : null;
      const id = given ?? synthesizeToolCallId();
      seenIds.add(id);
      const args = tc.function?.arguments;
      calls.push({
        id,
        name: typeof tc.function?.name === "string" ? tc.function.name : "",
        arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
      });
    }
    if (line.done === true) {
      const reason = typeof line.done_reason === "string" && line.done_reason ? line.done_reason : "stop";
      // Same mapping as Ollama's own /v1 (openai/openai.go lines 340-342).
      stopReason = reason === "stop" && calls.length > 0 ? "tool_calls" : reason;
      const prompt = count(line.prompt_eval_count) ?? 0;
      const completion = count(line.eval_count) ?? 0;
      const cached = count(line.prompt_eval_cached_count);
      if (prompt || completion) usage = { promptTokens: prompt, completionTokens: completion, ...(cached !== undefined ? { cachedTokens: cached } : {}) };
    }
  }

  for (const c of calls) yield { type: "tool_call", ...c };
  if (usage) yield { type: "usage", ...usage };
  yield { type: "done", stopReason, ...(firstTokenMs !== undefined ? { firstTokenMs } : {}) };
}
