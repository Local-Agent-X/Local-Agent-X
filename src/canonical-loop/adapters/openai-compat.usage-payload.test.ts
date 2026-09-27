// What a turn record carries about the request the runtime actually served:
// the usage counters, how many prompt tokens came from the prefix cache, the
// time-to-first-token, and whether the runtime accepted a prompt past its
// measured window (Ollama's /v1 cannot report a truncation — this flag is the
// only tell). Cached tokens get their OWN field: `cacheReadTokens` is
// Anthropic's separate count and the cost ledger prices it on top of input.
import { describe, it, expect, vi, beforeEach } from "vitest";

const streamMock = vi.fn();
vi.mock("../../providers/adapters/openai-http.js", () => ({
  openaiHttpAdapter: { stream: streamMock },
}));
vi.mock("../../context-manager/model-windows.js", () => ({
  resolveContextWindow: vi.fn(() => ({ tokens: 1_000_000, provenance: "probed" as const })),
}));
vi.mock("../../providers/types.js", () => ({
  markNoToolSupport: vi.fn(),
}));
vi.mock("../../providers/tool-capability-probe.js", () => ({
  noteLiveToolCallEvidence: vi.fn(),
  maybeVerifyToolSupport: vi.fn(async () => {}),
}));

import { createOpenAICompatAdapter } from "./openai-compat.js";
import { resolveContextWindow } from "../../context-manager/model-windows.js";

const mockWindow = vi.mocked(resolveContextWindow);

function usageStream(promptTokens: number, cachedTokens: number) {
  return async function* () {
    yield { type: "text" as const, delta: "ok" };
    yield { type: "usage" as const, promptTokens, completionTokens: 7, cachedTokens };
    yield { type: "done" as const, stopReason: "stop", firstTokenMs: 42 };
  };
}

async function runOneTurn() {
  const adapter = createOpenAICompatAdapter({ model: "qwen3:8b", baseURL: "http://127.0.0.1:11434/v1", apiKey: "k" });
  const result = await adapter.runTurn(
    {
      opId: "op-usage",
      turnIdx: 1,
      messages: [{ messageId: "m1", role: "user", content: { text: "hi" } }],
      tools: [],
    },
    () => {},
  );
  return result.providerState.providerPayload as Record<string, unknown>;
}

beforeEach(() => {
  streamMock.mockReset();
  mockWindow.mockReturnValue({ tokens: 1_000_000, provenance: "probed" });
});

describe("openai-compat turn record: usage, cache, first token", () => {
  it("records prompt/completion tokens, cached prompt tokens, and time-to-first-token", async () => {
    streamMock.mockImplementation(usageStream(120, 100));
    const payload = await runOneTurn();
    expect(payload.usageInputTokens).toBe(120);
    expect(payload.usageOutputTokens).toBe(7);
    expect(payload.promptCachedTokens).toBe(100);
    expect(payload.ttftMs).toBe(42);
    expect("cacheReadTokens" in payload).toBe(false);
    expect("promptOverWindow" in payload).toBe(false);
  });

  it("flags a prompt the runtime accepted past its measured window", async () => {
    mockWindow.mockReturnValue({ tokens: 4096, provenance: "probed" });
    streamMock.mockImplementation(usageStream(4832, 0));
    const payload = await runOneTurn();
    expect(payload.promptOverWindow).toBe(true);
  });

  it("never flags against a floor window — a guess must not accuse the runtime", async () => {
    mockWindow.mockReturnValue({ tokens: 8_192, provenance: "floor" });
    streamMock.mockImplementation(usageStream(20_000, 0));
    const payload = await runOneTurn();
    expect("promptOverWindow" in payload).toBe(false);
  });
});

describe("openai-compat turn trace", () => {
  it("carries the request as composed and the answer as received, raw text kept before extraction", async () => {
    // A text-tag tool call with prose around it: extraction moves the call to
    // pendingToolCalls and leaves the prose as `text`; the trace keeps the
    // original stream as `rawText` so the replay shows what the model wrote.
    const tagged = 'Let me look. <tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>';
    streamMock.mockImplementation(async function* () {
      yield { type: "request_sent" as const, params: { model: "qwen3:8b", temperature: 0.2, max_tokens: 16384, tools: ["read_file"] } };
      yield { type: "thinking" as const, delta: "plan: read the file" };
      yield { type: "text" as const, delta: tagged };
      yield { type: "usage" as const, promptTokens: 300, completionTokens: 40, cachedTokens: 250 };
      yield { type: "done" as const, stopReason: "stop", firstTokenMs: 33 };
    });
    const adapter = createOpenAICompatAdapter({ model: "qwen3:8b", baseURL: "http://127.0.0.1:11434/v1", apiKey: "k", systemPrompt: "You are LAX.", temperature: 0.2 });
    const result = await adapter.runTurn(
      {
        opId: "op-trace",
        turnIdx: 2,
        messages: [{ messageId: "m1", role: "user", content: { text: "read a.txt" } }],
        tools: [{ name: "read_file", description: "read", inputSchema: { type: "object" } }],
      },
      () => {},
    );
    const trace = result.trace!;
    expect(trace.model).toBe("qwen3:8b");
    expect(trace.baseURL).toBe("http://127.0.0.1:11434/v1");
    expect(trace.request.systemPrompt).toBe("You are LAX.");
    expect(trace.request.tools.map((t) => t.name)).toEqual(["read_file"]);
    // The model profile's card value outranks the generic setting (0.2 here).
    expect(trace.request.temperature).toBe(0.6);
    expect(trace.request.sent).toEqual({ model: "qwen3:8b", temperature: 0.2, max_tokens: 16384, tools: ["read_file"] });
    expect((trace.request.messages[0] as { role: string }).role).toBe("user");
    expect(trace.response.rawText).toBe(tagged);
    expect(trace.response.text).not.toContain("<tool_call>");
    expect(trace.response.toolCalls.map((c) => c.name)).toEqual(["read_file"]);
    expect(trace.response.thinking).toBe("plan: read the file");
    expect(trace.response.usage).toEqual({ promptTokens: 300, completionTokens: 40, cachedTokens: 250 });
    expect(trace.response.ttftMs).toBe(33);
    expect(trace.response.stopReason).toBe("stop");
    expect(trace.response.error).toBeNull();
    expect(trace.timing.modelMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(trace.timing.endedAt)).toBeGreaterThanOrEqual(Date.parse(trace.timing.startedAt));
  });
});

describe("openai-compat sampling from the model profile", () => {
  // Ollama's /v1 forces top_p 1.0 when a request omits it, overriding the
  // Modelfile's 0.95; the profile carries the model card's values instead.
  const run = async (model: string) => {
    streamMock.mockImplementation(async function* () {
      yield { type: "text" as const, delta: "ok" };
      yield { type: "done" as const, stopReason: "stop" };
    });
    const adapter = createOpenAICompatAdapter({ model, baseURL: "http://127.0.0.1:11434/v1", apiKey: "k", temperature: 0.2 });
    await adapter.runTurn({ opId: "op-sampling", turnIdx: 0, messages: [{ messageId: "m1", role: "user", content: { text: "hi" } }], tools: [] }, () => {});
    return streamMock.mock.calls.at(-1)![0] as { temperature?: number; topP?: number; presencePenalty?: number };
  };

  it("the 27B sends its card's thinking-mode values: temperature 0.6, top_p 0.95, presence_penalty 0", async () => {
    expect(await run("qwen3.6:27b")).toMatchObject({ temperature: 0.6, topP: 0.95, presencePenalty: 0 });
  });

  it("the 8B sends temperature 0.6 and top_p 0.95, and leaves presence_penalty to the runtime", async () => {
    const req = await run("qwen3:8b");
    expect(req).toMatchObject({ temperature: 0.6, topP: 0.95 });
    expect(req.presencePenalty).toBeUndefined();
  });

  it("a model with no profile sends exactly what it did before", async () => {
    const req = await run("nobody:1b");
    expect(req.temperature).toBe(0.2);
    expect(req.topP).toBeUndefined();
    expect(req.presencePenalty).toBeUndefined();
  });
});
