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
import { readFileSync } from "node:fs";
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
      const { getApiKey } = await import("../../auth/index.js");
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

      // Forced single-tool selection from the intent classifier. Pass
      // the canonical `{type:"tool", name}` shape; the codex-cli adapter
      // forwards it through ProviderRequest, and streamCodexResponse
      // converts to the API's `{type:"function", function:{name}}` shape.
      // Verify the named tool is in this turn's tools list before
      // forcing — otherwise the API would 400.
      const forced = req.forcedToolChoice;
      const canonicalToolChoice = forced && tools.some(t => t.name === forced.name)
        ? forced
        : "auto" as const;

      try {
        const stream = adapter.stream({
          apiKey,
          model: req.model,
          messages,
          systemPrompt: req.systemPrompt,
          tools: tools as Parameters<typeof adapter.stream>[0]["tools"],
          previousResponseId: req.previousResponseId,
          sessionId: req.sessionId,
          toolChoice: canonicalToolChoice,
          signal: req.signal,
        });

        // Codex emits a separate `usage` event BEFORE `done`. Buffer it so
        // we can attach to the canonical `done` frame's optional usage
        // field — same shape soak-metrics already reads from anthropic.
        let pendingUsage: { inputTokens: number; outputTokens: number } | undefined;

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
            case "usage": {
              // Codex CLI's separate usage event — buffer until done.
              const u = chunk as { promptTokens?: number; completionTokens?: number };
              pendingUsage = {
                inputTokens: u.promptTokens ?? 0,
                outputTokens: u.completionTokens ?? 0,
              };
              break;
            }
            case "done":
              yield {
                type: "done" as const,
                stopReason: chunk.stopReason,
                responseId: chunk.responseId,
                usage: pendingUsage,
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
            // "reasoning" is Codex-specific; not in TransportEvent contract.
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
  // Assistant turns that emitted tool_calls must round-trip them in the
  // Chat Completions message shape so codex-message-convert.ts sees the
  // tool_calls field and emits matching `function_call` input items.
  // Without this the next turn's function_call_output orphans on Codex.
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
    // gpt-5/gpt-5.5 on the Responses API support vision via input_image
    // content blocks. codex-message-convert.ts maps OpenAI Chat
    // Completions `image_url` parts into the Responses API shape, so
    // emitting the same multi-part user content used by openai-compat
    // and the anthropic transport works here too — different downstream
    // mapper, same upstream wire shape.
    return {
      role: "user",
      content: imagesToOpenAIParts(m.content, m.images),
    } as ChatCompletionMessageParam;
  }
  if (m.role === "system" || m.role === "user" || m.role === "assistant") {
    return { role: m.role, content: m.content } as ChatCompletionMessageParam;
  }
  return {
    role: "tool",
    tool_call_id: m.toolCallId ?? "tc-unknown",
    content: m.content,
  } as ChatCompletionMessageParam;
}

function imagesToOpenAIParts(
  text: string,
  images: Array<{ url: string; name: string; filePath?: string }>,
): Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }> {
  const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }> = [
    { type: "text", text },
  ];
  for (const img of images) {
    try {
      let dataUrl: string;
      if (img.url && img.url.startsWith("data:")) {
        dataUrl = img.url;
      } else if (img.filePath) {
        const data = readFileSync(img.filePath);
        const ext = (img.name.split(".").pop() || "png").toLowerCase();
        const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
        dataUrl = `data:${mime};base64,${data.toString("base64")}`;
      } else {
        continue;
      }
      parts.push({ type: "image_url", image_url: { url: dataUrl, detail: "auto" } });
    } catch {
      // Skip unreadable attachments rather than fail the whole turn.
    }
  }
  return parts;
}

function scrub(s: string): string {
  if (!s) return s;
  return s
    .replace(/sk-[a-zA-Z0-9_\-]+/g, "[REDACTED_KEY]")
    .replace(/Bearer\s+[a-zA-Z0-9_\-\.]+/gi, "Bearer [REDACTED]");
}
