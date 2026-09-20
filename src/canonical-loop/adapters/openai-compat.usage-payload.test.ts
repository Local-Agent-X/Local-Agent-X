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
