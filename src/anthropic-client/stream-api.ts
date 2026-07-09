import { buildAnthropicRateLimitHint, normalizeAnthropicModel, anthropicUsesAdaptiveThinking } from "../anthropic-models.js";
import { API_BASE, convertMessages } from "./request.js";
import { connectTimeout } from "../providers/connect-timeout.js";
import type { StreamEvent, StreamOptions } from "./types.js";

export async function* streamViaAPI(options: StreamOptions): AsyncGenerator<StreamEvent> {
  const { token, model, messages, systemPrompt, tools, maxTokens = 8192, toolChoice, forcedToolName, signal } = options;
  const resolvedModel = normalizeAnthropicModel(model, "api");
  const adaptive = anthropicUsesAdaptiveThinking(resolvedModel);

  // Fail fast if the caller already cancelled before we started.
  if (signal?.aborted) {
    yield { type: "error", error: "Anthropic request aborted before dispatch" };
    return;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": token,
    "anthropic-version": "2023-06-01",
    // interleaved-thinking is GA (auto-enabled) under adaptive thinking; the
    // beta header is only meaningful for the legacy enabled-thinking models.
    ...(adaptive ? {} : { "anthropic-beta": "interleaved-thinking-2025-05-14" }),
  };

  const body: Record<string, unknown> = {
    model: resolvedModel,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: convertMessages(messages),
    stream: true,
    // Thinking lets the model reason about blockers before acting. Adaptive
    // family (Fable 5, Opus 4.6/4.7/4.8, Sonnet 4.6): send only `adaptive` —
    // Fable 5 and Opus 4.7/4.8 reject `temperature`/`budget_tokens` with a
    // 400. Legacy models keep the enabled+budget+temperature shape (the API
    // requires temperature: 1 when enabled thinking is on).
    // `display: "summarized"` is required to get readable reasoning — on Opus
    // 4.8 / Sonnet 5 / Fable 5 the default is "omitted", which streams thinking
    // blocks with EMPTY text. Without it the "Thinking" UI block would be blank.
    ...(adaptive
      ? { thinking: { type: "adaptive", display: "summarized" } }
      : { thinking: { type: "enabled", budget_tokens: 3000 }, temperature: 1 }),
  };

  const anthropicTools = tools?.map(t => ({
    name: t.name, description: t.description, input_schema: t.parameters,
  })) as Array<{ name: string; description: string; input_schema: unknown; cache_control?: { type: "ephemeral" } }> | undefined;
  if (anthropicTools?.length) {
    // Anthropic prompt caching: mark the LAST tool with cache_control to
    // cache the entire tools array (everything above the marker). First
    // turn pays 1.25× base for cache-write; subsequent turns within the
    // 5-min TTL pay 0.1× base for cache-read. selectTools() now ships the
    // FILTERED set (not the whole inventory) and the deferred-tool manifest
    // (build-system-prompt.ts) names the rest, so this cached block — and its
    // cold-write — is sized to the tools actually loaded this turn.
    anthropicTools[anthropicTools.length - 1].cache_control = { type: "ephemeral" };
    body.tools = anthropicTools;
    if (forcedToolName && anthropicTools.some(t => t.name === forcedToolName)) {
      body.tool_choice = { type: "tool", name: forcedToolName };
    } else if (toolChoice === "required") {
      body.tool_choice = { type: "any" };
    }
  }

  // Connect timeout (60s) bounds ONLY the request/headers phase; it is cleared
  // the instant the response starts streaming. Otherwise a generation longer
  // than 60s is aborted mid-stream and a complete answer is truncated into an
  // error. The caller's external cancel signal stays wired for the whole stream
  // (below) so barge-in / op-cancel still aborts immediately.
  const conn = connectTimeout(60_000, signal, "Anthropic");

  let externalAbortHandler: (() => void) | null = null;
  try {
    const response = await fetch(`${API_BASE}/v1/messages`, {
      method: "POST", headers, body: JSON.stringify(body),
      signal: conn.signal,
    });
    conn.clear();

    if (!response.ok) {
      const errorText = await response.text();
      const hint = buildAnthropicRateLimitHint(response.status, token);
      yield { type: "error", error: `Anthropic ${response.status}: ${errorText.slice(0, 500)}${hint}` };
      return;
    }

    if (!response.body) {
      yield { type: "error", error: "No response body" };
      return;
    }

    const reader = response.body.getReader();
    // Wire the caller's signal to cancel the body reader so mid-stream
    // aborts (barge-in, op cancel) release the worker immediately
    // instead of blocking until the stream closes naturally.
    if (signal) {
      if (signal.aborted) {
        void reader.cancel().catch(() => {});
      } else {
        externalAbortHandler = () => { void reader.cancel().catch(() => {}); };
        signal.addEventListener("abort", externalAbortHandler, { once: true });
      }
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let currentToolId = "";
    let currentToolName = "";
    let currentToolArgs = "";
    let inputTokens = 0;
    let outputTokens = 0;
    // Cache fields stay undefined when the API doesn't report them — "absent"
    // and "0" are different downstream (context anchoring refuses absent).
    let cacheReadTokens: number | undefined;
    let cacheCreateTokens: number | undefined;
    let stopReason: string | undefined;
    let sawText = false, sawToolCall = false;
    let responseText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";

      for (const part of parts) {
        for (const line of part.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;

          let parsed: Record<string, unknown>;
          try { parsed = JSON.parse(data); } catch { continue; }

          const eventType = parsed.type as string;
          if (eventType === "message_start") {
            const usage = (parsed.message as Record<string, unknown>)?.usage as Record<string, number>;
            if (usage) {
              inputTokens = usage.input_tokens || 0;
              // input_tokens EXCLUDES the cached prefix; the cache read/write
              // counts arrive here. Without them the turn's recorded usage
              // undercounts context by the whole cached prefix (tools array +
              // prior turns) — the CLI path (stream-cli/stream-parse.ts)
              // already forwards both.
              if (typeof usage.cache_read_input_tokens === "number") cacheReadTokens = usage.cache_read_input_tokens;
              if (typeof usage.cache_creation_input_tokens === "number") cacheCreateTokens = usage.cache_creation_input_tokens;
            }
          } else if (eventType === "content_block_start") {
            const block = parsed.content_block as Record<string, unknown>;
            if (block?.type === "tool_use") {
              currentToolId = block.id as string;
              currentToolName = block.name as string;
              currentToolArgs = "";
            }
          } else if (eventType === "content_block_delta") {
            const delta = parsed.delta as Record<string, unknown>;
            if (delta?.type === "text_delta") { sawText = true; const t = delta.text as string; responseText += t; yield { type: "text", delta: t }; }
            // Extended-thinking summary deltas — reasoning, not answer text.
            // `signature_delta` (block signature) and redacted_thinking carry no
            // readable text and are intentionally ignored.
            else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") { yield { type: "thinking", delta: delta.thinking as string }; }
            else if (delta?.type === "input_json_delta") currentToolArgs += delta.partial_json as string;
          } else if (eventType === "content_block_stop") {
            if (currentToolId) {
              sawToolCall = true;
              yield { type: "tool_call", id: currentToolId, name: currentToolName, arguments: currentToolArgs };
              currentToolId = ""; currentToolName = ""; currentToolArgs = "";
            }
          } else if (eventType === "message_delta") {
            const usage = parsed.usage as Record<string, number>;
            if (usage) {
              outputTokens = usage.output_tokens || 0;
              // Some API versions restate cache counts on the final delta —
              // last-wins keeps whichever frame carried them.
              if (typeof usage.cache_read_input_tokens === "number") cacheReadTokens = usage.cache_read_input_tokens;
              if (typeof usage.cache_creation_input_tokens === "number") cacheCreateTokens = usage.cache_creation_input_tokens;
            }
            const delta = parsed.delta as Record<string, unknown>;
            if (delta?.stop_reason) stopReason = delta.stop_reason as string;
          }
        }
      }
    }

    const { classifyAnthropicResponse, logClassification } = await import("../response-classifier.js");
    const classification = classifyAnthropicResponse({
      hasText: sawText, hasToolCalls: sawToolCall, stopReason, inputTokens, outputTokens, responseText,
    });
    logClassification("anthropic", resolvedModel, classification);
    yield { type: "done", usage: { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens }, stopReason, classification };
  } catch (e) {
    yield { type: "error", error: `Anthropic error: ${(e as Error).message?.slice(0, 300)}` };
  } finally {
    conn.clear();
    if (externalAbortHandler && signal) {
      signal.removeEventListener("abort", externalAbortHandler);
    }
  }
}
