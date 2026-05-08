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

function scrub(s: string): string {
  if (!s) return s;
  return s
    .replace(/sk-ant-[a-zA-Z0-9_\-]+/g, "[REDACTED_API_KEY]")
    .replace(/sk-ant-oat[a-zA-Z0-9_\-]+/g, "[REDACTED_OAUTH]")
    .replace(/oauth:[a-zA-Z0-9_\-\.]+/g, "[REDACTED_OAUTH]")
    .replace(/Bearer\s+[a-zA-Z0-9_\-\.]+/gi, "Bearer [REDACTED]");
}
