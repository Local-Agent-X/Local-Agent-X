// Request-fit preflight at the adapter choke point. Regression: 2026-07-15,
// "hi" to an LM Studio gemma loaded at n_ctx 8,192 was sent as a 36,611-token
// request (system prompt + ~100 tool schemas) → raw engine 400
// (exceed_context_size_error). The adapter must never send a request whose
// fixed overhead can't fit — degrade tools when that alone makes it fit,
// refuse with a clear error when even that can't.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./openai-compat/stream-once.js", () => ({
  streamOnce: vi.fn(),
  applyToolCallTextFallback: vi.fn(),
}));
vi.mock("../../context-manager/model-windows.js", () => ({
  lookupContextWindow: vi.fn(),
}));
vi.mock("../../providers/types.js", () => ({
  markNoToolSupport: vi.fn(),
}));

import { createOpenAICompatAdapter } from "./openai-compat.js";
import { streamOnce } from "./openai-compat/stream-once.js";
import { lookupContextWindow } from "../../context-manager/model-windows.js";
import { markNoToolSupport } from "../../providers/types.js";
import type { TurnInput, AdapterReport } from "../adapter-contract.js";
import type { StreamOnceResult } from "./openai-compat/types.js";

const mockStream = vi.mocked(streamOnce);
const mockWindow = vi.mocked(lookupContextWindow);

function cleanResult(): StreamOnceResult {
  return {
    assembledText: "hello there",
    assembledThinking: "",
    pendingToolCalls: [],
    firstError: null,
    providerStop: "stop",
    usagePromptTokens: 10,
    usageCompletionTokens: 5,
    interruptedByInject: false,
  };
}

function hiInput(tools: TurnInput["tools"]): TurnInput {
  return {
    opId: "op-1",
    turnIdx: 1, // past turn-0 so no forced tool_choice interplay
    messages: [{ messageId: "m1", role: "user", content: { text: "hi" } }],
    tools,
  };
}

/** A tool whose serialized schema is ~`tokens` tokens (chars/3.5 estimate). */
function bigTool(tokens: number, name = "mega_tool") {
  return { name, description: "x".repeat(tokens * 3.5), inputSchema: { type: "object" } };
}

function makeAdapter() {
  return createOpenAICompatAdapter({
    model: "google/gemma-4-e4b",
    baseURL: "http://127.0.0.1:1234/v1",
    apiKey: "lm-studio",
    systemPrompt: "You are Agent X.",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStream.mockResolvedValue(cleanResult());
});

describe("openai-compat request-fit preflight", () => {
  it('regression: "hi" into an 8k-window model with an oversized tool manifest must not 400 — tools are dropped, request still goes out', async () => {
    mockWindow.mockReturnValue(8_192);
    const reports: AdapterReport[] = [];
    const adapter = makeAdapter();

    const result = await adapter.runTurn(hiInput([bigTool(36_000)]), r => reports.push(r));

    expect(mockStream).toHaveBeenCalledTimes(1);
    const sent = mockStream.mock.calls[0][0];
    expect(sent.tools).toHaveLength(0);
    expect(sent.toolChoice).toBeUndefined();
    expect(result.terminalReason).toBe("done");
    expect(reports.filter(r => r.kind === "error")).toHaveLength(0);
    // Window problem ≠ capability problem: the permanent no-tool latch must
    // NOT fire off a fit-degrade, even on a loopback endpoint.
    expect(vi.mocked(markNoToolSupport)).not.toHaveBeenCalled();
  });

  it("refuses to send when even the tool-less request cannot fit, with an actionable error", async () => {
    mockWindow.mockReturnValue(8_192);
    const reports: AdapterReport[] = [];
    const adapter = createOpenAICompatAdapter({
      model: "google/gemma-4-e4b",
      baseURL: "http://127.0.0.1:1234/v1",
      apiKey: "lm-studio",
      systemPrompt: "s".repeat(12_000 * 4), // ~12k-token system prompt into an 8k window
    });

    const result = await adapter.runTurn(hiInput([]), r => reports.push(r));

    expect(mockStream).not.toHaveBeenCalled();
    expect(result.terminalReason).toBe("error");
    const err = reports.find(r => r.kind === "error");
    expect(err).toBeDefined();
    if (err?.kind === "error") {
      expect(err.code).toBe("context_window_exceeded");
      expect(err.retryable).toBe(false);
      expect(err.message).toContain("8,192");
      expect(err.message).toMatch(/context length|context slider|num_ctx/);
    }
  });

  it("passes tools through untouched when the request fits", async () => {
    mockWindow.mockReturnValue(128_000);
    const adapter = makeAdapter();
    const tool = { name: "read_file", description: "read a file", inputSchema: { type: "object" } };

    const result = await adapter.runTurn(hiInput([tool]), () => {});

    expect(mockStream).toHaveBeenCalledTimes(1);
    const sent = mockStream.mock.calls[0][0];
    expect(sent.tools.map(t => t.name)).toEqual(["read_file"]);
    expect(result.terminalReason).toBe("done");
  });
});
