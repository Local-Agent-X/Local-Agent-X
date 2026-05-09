/**
 * Default Anthropic transport (Issue 09).
 *
 * Wraps the existing `streamAnthropicResponse` (CLI proxy / direct API
 * routing decided by the auth-anthropic module) and exposes it through
 * the adapter-facing `AnthropicTransport` interface.
 *
 * This file is intentionally separate from `anthropic.ts` so the adapter
 * sandbox audit (PRD §15 conformance I) sees only the adapter's own
 * imports — `node:child_process`, OAuth internals, and provider parse
 * logic live behind this transport boundary.
 *
 * Token resolution:
 *   - Lazy at first request via `getAnthropicApiKey`.
 *   - The token is held in this module's closure; it is NEVER passed to
 *     the canonical loop and NEVER appears in `provider_state` or events.
 *   - If the user has not authenticated, `getAnthropicApiKey` throws —
 *     the adapter surfaces that as an `error` adapter_report.
 */
import { readFileSync } from "node:fs";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type {
  AnthropicTransport,
  AnthropicTransportRequest,
  TransportEvent,
} from "./anthropic.js";

export function defaultAnthropicTransport(): AnthropicTransport {
  return {
    async *stream(req: AnthropicTransportRequest): AsyncIterable<TransportEvent> {
      const { streamAnthropicResponse } = await import("../../anthropic-client.js");
      const { getAnthropicApiKey } = await import("../../auth-anthropic.js");

      let token: string;
      try {
        token = await getAnthropicApiKey();
      } catch (e) {
        yield {
          type: "error",
          code: "auth_unavailable",
          message: scrub((e as Error).message ?? "anthropic auth not configured"),
          retryable: false,
        };
        yield { type: "done" };
        return;
      }

      const messages = req.messages.map(toOpenAiMessage);

      try {
        const stream = streamAnthropicResponse({
          token,
          model: req.model,
          messages,
          systemPrompt: req.systemPrompt,
          tools: req.tools.length > 0 ? req.tools : undefined,
          maxTokens: req.maxTokens,
          signal: req.signal,
          sessionId: req.sessionId,
        });

        for await (const ev of stream) {
          if (req.signal.aborted) return;
          if (ev.type === "text" && ev.delta) {
            yield { type: "text", delta: ev.delta };
          } else if (ev.type === "tool_call") {
            yield {
              type: "tool_call",
              id: ev.id ?? `tc-${Math.random().toString(36).slice(2, 10)}`,
              name: ev.name ?? "",
              arguments: ev.arguments ?? "",
            };
          } else if (ev.type === "error") {
            yield {
              type: "error",
              code: "transport_error",
              message: scrub(ev.error ?? "unknown anthropic transport error"),
              retryable: false,
            };
          } else if (ev.type === "done") {
            yield {
              type: "done",
              stopReason: ev.stopReason,
              // Forward usage including cache fields when present.
              usage: ev.usage
                ? {
                    inputTokens: ev.usage.inputTokens,
                    outputTokens: ev.usage.outputTokens,
                    cacheReadTokens: ev.usage.cacheReadTokens,
                    cacheCreateTokens: ev.usage.cacheCreateTokens,
                  }
                : undefined,
            };
          }
          // mcp_activity events are observability; the canonical loop
          // surfaces tool runs through `tool_started` / `tool_finished`
          // emitted by `turn-loop.dispatchTools`. Skip here.
        }
      } catch (e) {
        yield {
          type: "error",
          code: "transport_exception",
          message: scrub((e as Error).message ?? String(e)),
          retryable: false,
        };
        yield { type: "done" };
      }
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

function toOpenAiMessage(m: AnthropicTransportRequest["messages"][number]): ChatCompletionMessageParam {
  // Round-trip assistant tool_calls — same reason as codex-transport's
  // toOaiMessage. The downstream anthropic-client converts ChatCompletion
  // tool_calls into Anthropic SDK tool_use blocks; without this, prior
  // tool-using turns surface as orphan tool_results and the API rejects
  // the request. Drops tool_calls would break canonical chat for any
  // provider whose history includes a tool turn.
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map(tc => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    } as ChatCompletionMessageParam;
  }
  if (m.role === "user" && m.images && m.images.length > 0) {
    // Build OpenAI vision multi-part content (text + image_url base64).
    // anthropic-client/request.ts converts these to Anthropic's `image`
    // content blocks at request time — same wire shape used by the
    // legacy run-anthropic path, so vision quality on Sonnet/Opus is
    // unchanged.
    return { role: "user", content: imagesToOpenAIParts(m.content, m.images) } as ChatCompletionMessageParam;
  }
  if (m.role === "system" || m.role === "user" || m.role === "assistant") {
    return { role: m.role, content: m.content } as ChatCompletionMessageParam;
  }
  // tool
  return {
    role: "tool",
    tool_call_id: m.toolCallId ?? "tc-unknown",
    content: m.content,
  } as ChatCompletionMessageParam;
}

function imagesToOpenAIParts(
  text: string,
  images: Array<{ url: string; name: string; filePath?: string }>,
): Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: string } }> {
  const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: string } }> = [
    { type: "text", text },
  ];
  for (const img of images) {
    try {
      if (!img.filePath) continue;
      const data = readFileSync(img.filePath);
      const ext = (img.name.split(".").pop() || "png").toLowerCase();
      const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      parts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${data.toString("base64")}`, detail: "auto" } });
    } catch {
      // Skip unreadable attachments rather than fail the whole turn.
    }
  }
  return parts;
}

function scrub(s: string): string {
  if (!s) return s;
  return s
    .replace(/sk-ant-[a-zA-Z0-9_\-]+/g, "[REDACTED_API_KEY]")
    .replace(/sk-ant-oat[a-zA-Z0-9_\-]+/g, "[REDACTED_OAUTH]")
    .replace(/oauth:[a-zA-Z0-9_\-\.]+/g, "[REDACTED_OAUTH]")
    .replace(/Bearer\s+[a-zA-Z0-9_\-\.]+/gi, "Bearer [REDACTED]");
}
