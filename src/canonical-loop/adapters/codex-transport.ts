/**
 * Default Codex transport for the canonical loop.
 *
 * Wraps CodexCliAdapter (Responses API) and exposes it through the
 * AnthropicTransport interface so CodexAdapter can reuse the same
 * adapter scaffolding. The extra `previousResponseId` field enables
 * incremental-mode chaining across turns.
 *
 * This file is intentionally separate from codex.ts so the adapter
 * sandbox audit (PRD §15 conformance I) scopes correctly.
 */
import type {
  AnthropicTransportRequest,
  TransportEvent,
} from "./anthropic.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

export interface CodexTransportRequest extends AnthropicTransportRequest {
  previousResponseId?: string;
}

export interface CodexTransport {
  stream(req: CodexTransportRequest): AsyncIterable<TransportEvent & { responseId?: string }>;
}

export function defaultCodexTransport(): CodexTransport {
  return {
    async *stream(req: CodexTransportRequest) {
      const { getApiKey } = await import("../../auth.js");
      const { CodexCliAdapter } = await import("../../providers/adapters/codex-cli.js");

      let apiKey: string;
      try {
        apiKey = await getApiKey();
      } catch (e) {
        yield {
          type: "error" as const,
          code: "auth_unavailable",
          message: scrub((e as Error).message ?? "codex auth not configured"),
          retryable: false,
        };
        yield { type: "done" as const };
        return;
      }

      const adapter = new CodexCliAdapter();
      const messages = req.messages.map(toOaiMessage);
      const tools = req.tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>,
      }));

      try {
        const stream = adapter.stream({
          apiKey,
          model: req.model,
          messages,
          systemPrompt: req.systemPrompt,
          tools: tools as Parameters<typeof adapter.stream>[0]["tools"],
          previousResponseId: req.previousResponseId,
          sessionId: req.sessionId,
          toolChoice: "auto",
          signal: req.signal,
        });

        for await (const chunk of stream) {
          if (req.signal?.aborted) return;
          switch (chunk.type) {
            case "text":
              if (chunk.delta) yield { type: "text" as const, delta: chunk.delta };
              break;
            case "tool_call":
              yield {
                type: "tool_call" as const,
                id: chunk.id,
                name: chunk.name,
                arguments: chunk.arguments,
              };
              break;
            case "done":
              yield {
                type: "done" as const,
                stopReason: chunk.stopReason,
                responseId: chunk.responseId,
              };
              return;
            case "error":
              yield {
                type: "error" as const,
                code: "transport_error",
                message: scrub(chunk.message),
                retryable: false,
              };
              break;
            // "reasoning" and "usage" are Codex-specific; not in TransportEvent contract.
          }
        }
      } catch (e) {
        yield {
          type: "error" as const,
          code: "transport_exception",
          message: scrub((e as Error).message ?? String(e)),
          retryable: false,
        };
        yield { type: "done" as const };
      }
    },
  };
}

function toOaiMessage(m: AnthropicTransportRequest["messages"][number]): ChatCompletionMessageParam {
  if (m.role === "system" || m.role === "user" || m.role === "assistant") {
    return { role: m.role, content: m.content } as ChatCompletionMessageParam;
  }
  return {
    role: "tool",
    tool_call_id: m.toolCallId ?? "tc-unknown",
    content: m.content,
  } as ChatCompletionMessageParam;
}

function scrub(s: string): string {
  if (!s) return s;
  return s
    .replace(/sk-[a-zA-Z0-9_\-]+/g, "[REDACTED_KEY]")
    .replace(/Bearer\s+[a-zA-Z0-9_\-\.]+/gi, "Bearer [REDACTED]");
}
