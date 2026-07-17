// The call-site contract for live tool-capability evidence: after a turn
// SETTLES cleanly on a LOOPBACK endpoint (the same shouldLatchNoToolSupport
// policy the no-tool latch obeys), the adapter records free evidence when
// the turn itself produced structured tool calls, and otherwise fires the
// background probe exactly once per (baseURL, model) per process — never for
// cloud or LAN baseURLs, never on errored turns, and never as awaited work a
// turn could pay latency for. stream-once is mocked (the turn itself),
// global fetch is stubbed (the probe's only transport), and the REAL
// scheduler + capability store run underneath against a throwaway
// LAX_DATA_DIR — so these tests prove the integrated seam, not a mock of it.
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

import { createOpenAICompatAdapter } from "./openai-compat.js";
import { streamOnce } from "./openai-compat/stream-once.js";
import { getToolsVerified, hasNoTools, recordNoTools, _resetForTests } from "../../providers/model-capabilities-store.js";
import type { TurnInput } from "../adapter-contract.js";
import type { StreamOnceResult } from "./openai-compat/types.js";

const LOOPBACK = "http://127.0.0.1:11434/v1";
const LAN = "http://192.168.1.50:1234/v1";
const CLOUD = "https://api.example-frontier.test/v1";

const mockStream = vi.mocked(streamOnce);

function cleanResult(overrides: Partial<StreamOnceResult> = {}): StreamOnceResult {
  return {
    assembledText: "hello there",
    assembledThinking: "",
    pendingToolCalls: [],
    firstError: null,
    providerStop: "stop",
    usagePromptTokens: 10,
    usageCompletionTokens: 5,
    interruptedByInject: false,
    ...overrides,
  };
}

function input(turnIdx: number): TurnInput {
  return {
    opId: "op-verify",
    turnIdx,
    messages: [{ messageId: "m1", role: "user", content: { text: "hi" } }],
    tools: [],
  };
}

function makeAdapter(baseURL: string, model: string) {
  return createOpenAICompatAdapter({ model, baseURL, apiKey: "ollama", systemPrompt: "You are Agent X." });
}

/** A 200 completion whose choice is a structured ping tool_call. */
function pingCompletion() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "ping", arguments: "{}" } }] },
        finish_reason: "tool_calls",
      }],
    }),
  };
}

/** Drain the fire-and-forget probe chain (microtasks flush before macrotasks). */
function settle(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

let dir: string;
const prevEnv = process.env.LAX_DATA_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-cs-verify-"));
  process.env.LAX_DATA_DIR = dir;
  _resetForTests();
  vi.clearAllMocks();
  mockStream.mockResolvedValue(cleanResult());
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevEnv;
  _resetForTests();
  vi.unstubAllGlobals();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("openai-compat post-turn live evidence call site", () => {
  it("fires the probe once after a clean local turn and records the result — a second turn does not re-fire", async () => {
    const f = vi.fn().mockResolvedValue(pingCompletion());
    vi.stubGlobal("fetch", f);
    const adapter = makeAdapter(LOOPBACK, "cs-once");

    await adapter.runTurn(input(1), () => {});
    await adapter.runTurn(input(2), () => {});
    await settle();

    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(getToolsVerified(LOOPBACK, "cs-once")?.ok).toBe(true);
  });

  it("free positive evidence: a turn that produced structured tool calls records {ok:true} with NO probe fetch", async () => {
    mockStream.mockResolvedValue(cleanResult({
      assembledText: "",
      pendingToolCalls: [{ id: "t1", name: "read_file", arguments: "{}" }],
    }));
    const f = vi.fn().mockResolvedValue(pingCompletion());
    vi.stubGlobal("fetch", f);
    const adapter = makeAdapter(LOOPBACK, "cs-evidence");

    await adapter.runTurn(input(1), () => {});
    await settle();

    expect(f).not.toHaveBeenCalled(); // live evidence is free — no HTTP spent
    expect(getToolsVerified(LOOPBACK, "cs-evidence")?.ok).toBe(true);
    expect(hasNoTools(LOOPBACK, "cs-evidence")).toBe(false);
  });

  it("adds zero latency: the turn resolves even while the probe's fetch never does", async () => {
    // A never-resolving fetch. If runTurn awaited the probe anywhere, this
    // test would hang into the suite timeout — resolving is the proof.
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const adapter = makeAdapter(LOOPBACK, "cs-nonblocking");

    const result = await adapter.runTurn(input(1), () => {});

    expect(result.terminalReason).toBe("done");
  });

  it("never fires for a cloud baseURL", async () => {
    const f = vi.fn().mockResolvedValue(pingCompletion());
    vi.stubGlobal("fetch", f);
    const adapter = makeAdapter(CLOUD, "cs-cloud");

    await adapter.runTurn(input(1), () => {});
    await settle();

    expect(f).not.toHaveBeenCalled();
    expect(getToolsVerified(CLOUD, "cs-cloud")).toBeUndefined();
  });

  it("never fires for a LAN baseURL — the call-site gate is the same loopback-only latch policy", async () => {
    const f = vi.fn().mockResolvedValue(pingCompletion());
    vi.stubGlobal("fetch", f);
    const adapter = makeAdapter(LAN, "cs-lan");

    await adapter.runTurn(input(1), () => {});
    await settle();

    expect(f).not.toHaveBeenCalled();
    expect(getToolsVerified(LAN, "cs-lan")).toBeUndefined();
  });

  it("does not fire on an errored turn — an engine that failed proves nothing", async () => {
    mockStream.mockResolvedValue(cleanResult({
      assembledText: "",
      firstError: { code: "provider_error", message: "boom" },
    }));
    const f = vi.fn().mockResolvedValue(pingCompletion());
    vi.stubGlobal("fetch", f);
    const adapter = makeAdapter(LOOPBACK, "cs-errored");

    await adapter.runTurn(input(1), () => {});
    await settle();

    expect(f).not.toHaveBeenCalled();
  });

  it("does not fire when the registry already holds a real negative fact", async () => {
    recordNoTools(LOOPBACK, "cs-known");
    const f = vi.fn().mockResolvedValue(pingCompletion());
    vi.stubGlobal("fetch", f);
    const adapter = makeAdapter(LOOPBACK, "cs-known");

    await adapter.runTurn(input(1), () => {});
    await settle();

    expect(f).not.toHaveBeenCalled();
  });
});
