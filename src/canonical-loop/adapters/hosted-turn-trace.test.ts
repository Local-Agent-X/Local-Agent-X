/**
 * Hosted adapters (Anthropic, Codex, Gemini) return a per-turn trace the way
 * the openai-compat adapter does: the request as composed for the transport
 * and the answer as streamed, thinking included. A trace never carries a
 * credential the transport request holds (Gemini's apiKey).
 */
import { describe, it, expect } from "vitest";
import { AnthropicAdapter, type AnthropicTransport } from "./anthropic.js";
import { CodexAdapter } from "./codex.js";
import type { CodexTransport } from "./codex-transport.js";
import { GeminiNativeAdapter } from "./gemini-native.js";
import type { GeminiNativeTransport } from "./gemini-native-transport.js";
import type { Adapter, TurnInput, TurnResult } from "../adapter-contract.js";

const events = [
  { type: "thinking", delta: "Look at the " },
  { type: "thinking", delta: "file first." },
  { type: "text", delta: "Reading it." },
  { type: "tool_call", id: "call_1", name: "read", arguments: "{\"path\":\"a.ts\"}" },
  { type: "done", stopReason: "tool_use", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheCreateTokens: 50 } },
];

function transport<T>(): T {
  return { async *stream() { for (const e of events) yield e; } } as unknown as T;
}

const input: TurnInput = {
  opId: "op-trace", turnIdx: 0,
  messages: [{ messageId: "u1", role: "user", content: { text: "fix a.ts" } }],
  tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }],
} as unknown as TurnInput;

async function turn(adapter: Adapter): Promise<TurnResult> {
  return adapter.runTurn(input, () => {});
}

const adapters: Array<[string, () => Adapter]> = [
  ["anthropic", () => new AnthropicAdapter({ transport: transport<AnthropicTransport>(), model: "claude-opus-5-5", systemPrompt: "sys", effort: "high" })],
  ["codex", () => new CodexAdapter({ transport: transport<CodexTransport>(), model: "gpt-5.5", systemPrompt: "sys" })],
  ["gemini", () => new GeminiNativeAdapter({ transport: transport<GeminiNativeTransport>(), model: "gemini-3-pro", apiKey: "SECRET-KEY-123", systemPrompt: "sys", thinking: true })],
];

describe.each(adapters)("%s adapter trace", (_name, make) => {
  it("records the request as composed and the answer as streamed", async () => {
    const { trace } = await turn(make());
    expect(trace).toBeDefined();
    expect(trace!.request.systemPrompt).toBe("sys");
    expect(trace!.request.messages.length).toBeGreaterThan(0);
    expect(JSON.stringify(trace!.request.messages)).toContain("fix a.ts");
    expect(trace!.request.tools.map((t) => t.name)).toEqual(["read"]);
    expect(trace!.response.text).toBe("Reading it.");
    expect(trace!.response.rawText).toBe("Reading it.");
    expect(trace!.response.thinking).toBe("Look at the file first.");
    expect(trace!.response.toolCalls).toEqual([{ id: "call_1", name: "read", arguments: "{\"path\":\"a.ts\"}" }]);
    expect(trace!.response.stopReason).toBe("tool_use");
    expect(trace!.response.error).toBeNull();
    expect(trace!.response.ttftMs).toBeGreaterThanOrEqual(0);
    expect(trace!.timing.modelMs).toBeGreaterThanOrEqual(0);
  });

  it("never carries the transport's credential or abort signal", async () => {
    const { trace } = await turn(make());
    const json = JSON.stringify(trace);
    expect(json).not.toContain("SECRET-KEY-123");
    expect(json).not.toContain("apiKey");
    expect(json).not.toContain("signal");
  });
});

describe("what each provider's trace says about its request", () => {
  it("anthropic: the prompt counts cache reads and writes, and the effort sent is recorded", async () => {
    const { trace } = await turn(adapters[0][1]());
    expect(trace!.response.usage).toEqual({ promptTokens: 1050, completionTokens: 20, cachedTokens: 900 });
    expect(trace!.request.reasoningEffort).toBe("high");
    expect(trace!.request.options).toMatchObject({ cacheConversation: true });
  });

  it("codex: the effort the step was sent at is recorded", async () => {
    const { trace } = await turn(adapters[1][1]());
    expect(trace!.request.reasoningEffort).toBeTruthy();
    expect(trace!.response.usage).toMatchObject({ promptTokens: 100, completionTokens: 20 });
  });

  it("gemini: the thinking switch is recorded as an option", async () => {
    const { trace } = await turn(adapters[2][1]());
    expect(trace!.request.options).toEqual({ thinking: true });
  });
});
