/**
 * The learned no-tools latch is reversible. Before 2026-09-23 one empty reply
 * with tools attached wrote `noTools: true` to the install's capability store,
 * permanently: a 27B that had just made a native tool call answered one
 * `...tool, user, user` round with nothing and lost native tools for the rest
 * of the process and every process after (op-outcomes, EXP-12c). Three rules
 * now: verified tool evidence outranks an empty reply (no latch at all); a
 * learned latch expires; live evidence clears one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./stream-once.js", () => ({
  streamOnce: vi.fn(),
  applyToolCallTextFallback: vi.fn(),
}));
vi.mock("../../../context-manager/model-windows.js", () => ({
  resolveContextWindow: () => ({ tokens: 65_536, provenance: "probed" as const }),
}));

import { createOpenAICompatAdapter, shouldLatchNoToolSupport } from "../openai-compat.js";
import { streamOnce } from "./stream-once.js";
import { noteLiveToolCallEvidence } from "../../../providers/tool-capability-probe.js";
import {
  hasNoTools, recordNoTools, clearNoTools, recordToolsVerified, getToolsVerified, NO_TOOLS_LATCH_TTL_MS, _resetForTests,
} from "../../../providers/model-capabilities-store.js";
import type { TurnInput } from "../../adapter-contract.js";
import type { StreamOnceResult } from "./types.js";

const LOOPBACK = "http://127.0.0.1:11434/v1";
const MODEL = "qwen3.6:27b";
const mockStream = vi.mocked(streamOnce);

let dataDir: string;
const prevDataDir = process.env.LAX_DATA_DIR;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lax-latch-"));
  process.env.LAX_DATA_DIR = dataDir;
  _resetForTests();
  vi.clearAllMocks();
});
afterEach(() => {
  if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prevDataDir;
  _resetForTests();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("a learned no-tools latch expires; a seeded one does not exist to expire", () => {
  it("holds within the TTL, lets go after it, and a fresh observation restamps an expired one", () => {
    const t0 = Date.parse("2026-09-23T10:00:00Z");
    recordNoTools(LOOPBACK, MODEL, t0);
    expect(hasNoTools(LOOPBACK, MODEL, t0 + 1_000)).toBe(true);
    expect(hasNoTools(LOOPBACK, MODEL, t0 + NO_TOOLS_LATCH_TTL_MS - 1)).toBe(true);
    expect(hasNoTools(LOOPBACK, MODEL, t0 + NO_TOOLS_LATCH_TTL_MS)).toBe(false);
    // The model empties again an hour later: it re-latches for another window.
    recordNoTools(LOOPBACK, MODEL, t0 + NO_TOOLS_LATCH_TTL_MS + 5_000);
    expect(hasNoTools(LOOPBACK, MODEL, t0 + NO_TOOLS_LATCH_TTL_MS + 6_000)).toBe(true);
  });

  it("clearNoTools lifts a learned latch", () => {
    recordNoTools(LOOPBACK, MODEL);
    expect(hasNoTools(LOOPBACK, MODEL)).toBe(true);
    clearNoTools(LOOPBACK, MODEL);
    expect(hasNoTools(LOOPBACK, MODEL)).toBe(false);
  });
});

describe("evidence outranks an empty reply", () => {
  it("shouldLatchNoToolSupport is false for a loopback model with a structured tool call on file", () => {
    expect(shouldLatchNoToolSupport(LOOPBACK, MODEL)).toBe(true);
    recordToolsVerified(LOOPBACK, MODEL, true);
    expect(shouldLatchNoToolSupport(LOOPBACK, MODEL)).toBe(false);
    // Endpoint-only gate (no model) stays a plain loopback check.
    expect(shouldLatchNoToolSupport(LOOPBACK)).toBe(true);
    expect(shouldLatchNoToolSupport("https://api.example-frontier.test/v1", MODEL)).toBe(false);
  });

  it("live evidence of a structured tool call clears a learned latch", () => {
    recordNoTools(LOOPBACK, MODEL);
    noteLiveToolCallEvidence(LOOPBACK, MODEL);
    expect(hasNoTools(LOOPBACK, MODEL)).toBe(false);
    expect(getToolsVerified(LOOPBACK, MODEL)?.ok).toBe(true);
  });
});

describe("the adapter, end to end", () => {
  const result = (over: Partial<StreamOnceResult>): StreamOnceResult => ({
    assembledText: "", assembledThinking: "", pendingToolCalls: [], firstError: null, providerStop: "stop",
    usagePromptTokens: 10, usageCompletionTokens: 1, interruptedByInject: false, ...over,
  });
  const input = (turnIdx: number): TurnInput => ({
    opId: "op-1", turnIdx,
    messages: [{ messageId: "u1", role: "user", content: { text: "read it" } }],
    tools: [{ name: "read", description: "read a file", inputSchema: { type: "object" } }],
  });
  const adapter = () => createOpenAICompatAdapter({ model: MODEL, baseURL: LOOPBACK, apiKey: "ollama", systemPrompt: "sys" });

  it("a native tool call on turn 1, then an empty reply on turn 2: the retry happens, the latch does not", async () => {
    const a = adapter();
    mockStream.mockResolvedValueOnce(result({ providerStop: "tool_calls", pendingToolCalls: [{ id: "c1", name: "read", arguments: "{}" }] }));
    await a.runTurn(input(0), () => {});
    expect(getToolsVerified(LOOPBACK, MODEL)?.ok).toBe(true);

    // Empty with tools, then the retry without tools answers.
    mockStream.mockResolvedValueOnce(result({}));
    mockStream.mockResolvedValueOnce(result({ assembledText: "Got it." }));
    await a.runTurn(input(1), () => {});
    expect(mockStream).toHaveBeenCalledTimes(3);
    expect((mockStream.mock.calls[2][0] as { tools: unknown[] }).tools).toHaveLength(0);
    expect(hasNoTools(LOOPBACK, MODEL)).toBe(false);
  });

  it("with no evidence at all, an empty reply still latches — for the TTL, not forever", async () => {
    mockStream.mockResolvedValueOnce(result({}));
    mockStream.mockResolvedValueOnce(result({ assembledText: "hello" }));
    await adapter().runTurn(input(0), () => {});
    expect(hasNoTools(LOOPBACK, MODEL)).toBe(true);
    expect(hasNoTools(LOOPBACK, MODEL, Date.now() + NO_TOOLS_LATCH_TTL_MS + 1)).toBe(false);
  });
});
