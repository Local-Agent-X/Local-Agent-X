// Text tool-call rescue is endpoint-gated: local/unknown OpenAI-compat
// endpoints get it, frontier endpoints that emit structured tool_calls
// (xAI, Gemini) do not — there a JSON example in the answer must never
// dispatch. stream-once is mocked so only the adapter's gate is under test.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./openai-compat/stream-once.js", () => ({
  streamOnce: vi.fn(),
  applyToolCallTextFallback: vi.fn(),
}));
vi.mock("../../context-manager/model-windows.js", () => ({
  resolveContextWindow: () => ({ tokens: 128_000, provenance: "probed" as const }),
}));

import { createOpenAICompatAdapter, shouldRescueTextToolCalls } from "./openai-compat.js";
import { applyToolCallTextFallback, streamOnce } from "./openai-compat/stream-once.js";
import { _resetForTests } from "../../providers/model-capabilities-store.js";
import type { TurnInput } from "../adapter-contract.js";

const input: TurnInput = {
  opId: "op-rescue",
  turnIdx: 1,
  messages: [{ messageId: "m1", role: "user", content: { text: "hi" } }],
  tools: [],
};

let dir: string;
const prevEnv = process.env.LAX_DATA_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-text-rescue-"));
  process.env.LAX_DATA_DIR = dir;
  _resetForTests();
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  vi.mocked(streamOnce).mockResolvedValue({
    assembledText: '{"name":"bash","arguments":{"command":"ls"}}',
    assembledThinking: "",
    pendingToolCalls: [],
    firstError: null,
    providerStop: "stop",
    usagePromptTokens: 10,
    usageCompletionTokens: 5,
    interruptedByInject: false,
  });
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevEnv;
  _resetForTests();
  vi.unstubAllGlobals();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("shouldRescueTextToolCalls", () => {
  it("is off for xAI and Gemini endpoints", () => {
    expect(shouldRescueTextToolCalls("https://api.x.ai/v1")).toBe(false);
    expect(shouldRescueTextToolCalls("https://generativelanguage.googleapis.com/v1beta/openai")).toBe(false);
  });

  it("stays on for local, LAN, other cloud, and unparseable endpoints", () => {
    expect(shouldRescueTextToolCalls("http://127.0.0.1:11434/v1")).toBe(true);
    expect(shouldRescueTextToolCalls("http://192.168.1.50:1234/v1")).toBe(true);
    expect(shouldRescueTextToolCalls("https://ollama.com/v1")).toBe(true);
    expect(shouldRescueTextToolCalls("not a url")).toBe(true);
  });
});

describe("openai-compat text-rescue call site", () => {
  it("runs the fallback on a local endpoint", async () => {
    const adapter = createOpenAICompatAdapter({ model: "qwen3:30b", baseURL: "http://127.0.0.1:11434/v1", apiKey: "ollama" });
    await adapter.runTurn(input, () => {});
    expect(applyToolCallTextFallback).toHaveBeenCalledTimes(1);
  });

  it("skips the fallback on xAI", async () => {
    const adapter = createOpenAICompatAdapter({ model: "grok-4", baseURL: "https://api.x.ai/v1", apiKey: "k" });
    await adapter.runTurn(input, () => {});
    expect(applyToolCallTextFallback).not.toHaveBeenCalled();
  });
});
