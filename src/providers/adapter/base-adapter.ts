/**
 * BaseAdapter — abstract contract every provider implementation extends.
 *
 * The dispatcher (run-standard.ts) holds a Map<providerName, BaseAdapter>
 * and calls `stream()` / `invoke()` without knowing whether the adapter
 * is talking to an HTTP API, a local subprocess, or a CLI proxy. Adding
 * a new provider = one new file under src/providers/adapters/ + one
 * registry registration.
 *
 * Same shape, every provider, no per-provider conditionals at the call site.
 */

import type { ProviderRequest, StreamChunk, ProviderResponse } from "./types.js";

export abstract class BaseAdapter {
  /**
   * Stable provider identifier used by the registry (e.g. "anthropic-http",
   * "anthropic-cli", "openai-http", "codex-cli").
   * Subclasses set this in their constructor or as a static field.
   */
  abstract readonly name: string;

  /**
   * Stream a request as normalized StreamChunks. Adapters MUST yield a
   * `done` chunk at the end (success or stop) and a `usage` chunk if the
   * provider reports token counts. On fatal error, yield a single `error`
   * chunk and return — do not throw mid-stream.
   *
   * Adapters MUST honor `req.signal` — abort fetches, kill subprocesses,
   * close SSE connections.
   */
  abstract stream(req: ProviderRequest): AsyncIterable<StreamChunk>;

  /**
   * Non-streaming convenience: collect the stream into a single result.
   * Default impl folds `stream()`; adapters can override if the provider
   * has a faster non-streaming endpoint.
   */
  async invoke(req: ProviderRequest): Promise<ProviderResponse> {
    let text = "";
    const toolCalls: { id: string; name: string; arguments: string }[] = [];
    const argDeltaBuf = new Map<string, string>();
    let usage = { promptTokens: 0, completionTokens: 0 };
    let stopReason = "end_turn";

    for await (const chunk of this.stream(req)) {
      switch (chunk.type) {
        case "text":
          text += chunk.delta;
          break;
        case "tool_call":
          toolCalls.push({ id: chunk.id, name: chunk.name, arguments: chunk.arguments });
          break;
        case "tool_call_delta":
          argDeltaBuf.set(chunk.id, (argDeltaBuf.get(chunk.id) || "") + chunk.argumentsDelta);
          break;
        case "usage":
          usage = { promptTokens: chunk.promptTokens, completionTokens: chunk.completionTokens };
          break;
        case "done":
          stopReason = chunk.stopReason;
          break;
        case "error":
          throw new Error(chunk.message);
      }
    }

    // Resolve any tool calls that came in only as deltas (provider streamed
    // arguments incrementally without a final assembled `tool_call`).
    for (const [id, args] of argDeltaBuf) {
      if (!toolCalls.find(tc => tc.id === id)) {
        toolCalls.push({ id, name: "", arguments: args });
      }
    }

    return { text, toolCalls, usage, stopReason };
  }
}
