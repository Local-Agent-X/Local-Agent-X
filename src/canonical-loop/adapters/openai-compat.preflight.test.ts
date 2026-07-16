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
  resolveContextWindow: vi.fn(),
}));
vi.mock("../../providers/types.js", () => ({
  markNoToolSupport: vi.fn(),
}));

import { createOpenAICompatAdapter } from "./openai-compat.js";
import { streamOnce } from "./openai-compat/stream-once.js";
import { resolveContextWindow } from "../../context-manager/model-windows.js";
import { markNoToolSupport } from "../../providers/types.js";
import type { TurnInput, AdapterReport } from "../adapter-contract.js";
import type { StreamOnceResult } from "./openai-compat/types.js";

const mockStream = vi.mocked(streamOnce);
const mockWindow = vi.mocked(resolveContextWindow);

/** A window we MEASURED off a live runtime — the preflight may act on it. */
function probed(tokens: number) {
  mockWindow.mockReturnValue({ tokens, provenance: "probed" as const });
}
/**
 * The placeholder for a local model that hasn't loaded yet. Same integer as a
 * real 8k window — which is precisely why provenance has to carry the
 * difference, and why these tests must never assert on the number alone.
 */
function floor() {
  mockWindow.mockReturnValue({ tokens: 8_192, provenance: "floor" as const });
}

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
    probed(8_192);
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
    probed(8_192);
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
    probed(128_000);
    const adapter = makeAdapter();
    const tool = { name: "read_file", description: "read a file", inputSchema: { type: "object" } };

    const result = await adapter.runTurn(hiInput([tool]), () => {});

    expect(mockStream).toHaveBeenCalledTimes(1);
    const sent = mockStream.mock.calls[0][0];
    expect(sent.tools.map(t => t.name)).toEqual(["read_file"]);
    expect(result.terminalReason).toBe("done");
  });

  // The deadlock. An unloaded local model reports no window, so lookup returns
  // the 8,192 FLOOR — a guess. Refusing on it is terminal and unrecoverable:
  // the refused send is the one that would load the model and reveal its real
  // window (qwen3.6:27b actually serves 262,144). Every subsequent turn
  // re-refuses on the same stale guess, forever. Shipped 2026-07-15 when the
  // preflight landed six hours after the floor and voided its "self-corrects
  // once the model loads" premise. The old tests couldn't catch it: they
  // mocked a bare 8192, which is exactly the ambiguity that caused the bug.
  describe("unknown window (floor) — a guess must never be grounds for refusal", () => {
    it("regression: sends a too-big request anyway when the window is only a floor, so the model can load", async () => {
      floor();
      const reports: AdapterReport[] = [];
      const adapter = createOpenAICompatAdapter({
        model: "qwen3.6:27b",
        baseURL: "http://127.0.0.1:11434/v1",
        apiKey: "ollama",
        systemPrompt: "s".repeat(12_000 * 4), // ~12k tokens: "too_big" against the 8k floor
      });

      const result = await adapter.runTurn(hiInput([]), r => reports.push(r));

      expect(mockStream).toHaveBeenCalledTimes(1);
      expect(result.terminalReason).toBe("done");
      expect(reports.filter(r => r.kind === "error")).toHaveLength(0);
    });

    it("keeps tools when only a floor says they don't fit — a 262k model must not be stripped on a guess", async () => {
      floor();
      const adapter = makeAdapter();

      const result = await adapter.runTurn(hiInput([bigTool(36_000)]), () => {});

      expect(mockStream).toHaveBeenCalledTimes(1);
      expect(mockStream.mock.calls[0][0].tools).toHaveLength(1);
      expect(result.terminalReason).toBe("done");
      expect(vi.mocked(markNoToolSupport)).not.toHaveBeenCalled();
    });
  });
});
