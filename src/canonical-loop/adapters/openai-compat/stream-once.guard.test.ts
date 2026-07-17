// Degenerate-stream guard WIRING: the guard arms only for local endpoints,
// trips mid-stream, tears the transport down early, preserves the partial
// text, surfaces exactly ONE `stopped` marker on the op-stream bus, and the
// turn ends cleanly (done, no retries) instead of error.

import { describe, it, expect, vi, beforeEach } from "vitest";

const streamMock = vi.fn();

vi.mock("../../../providers/adapters/openai-http.js", () => ({
  openaiHttpAdapter: { stream: streamMock },
}));
vi.mock("../../../context-manager/model-windows.js", () => ({
  resolveContextWindow: vi.fn(() => ({ tokens: 1_000_000, provenance: "probed" as const })),
}));
vi.mock("../../../providers/types.js", () => ({
  markNoToolSupport: vi.fn(),
}));
// Advisory capability bookkeeping fires after tool-less turns on loopback —
// neutralize it so no background probe/registry write escapes the test.
vi.mock("../../../providers/tool-capability-probe.js", () => ({
  noteLiveToolCallEvidence: vi.fn(),
  maybeVerifyToolSupport: vi.fn(async () => {}),
}));

import { streamOnce } from "./stream-once.js";
import { createOpenAICompatAdapter } from "../openai-compat.js";
import { DEGENERATE_STREAM_STOP_REASON } from "../stream-guards.js";
import { extractToolCallsFromText } from "../tool-call-text-extractor.js";
import { resolveContextWindow } from "../../../context-manager/model-windows.js";
import { markNoToolSupport } from "../../../providers/types.js";
import { LOCAL_DEFAULT_MAX_TOKENS } from "../../../providers/adapter/types.js";
import type { AdapterReport } from "../../adapter-contract.js";
import type { ProviderRequest } from "../../../providers/adapter/types.js";

const mockWindow = vi.mocked(resolveContextWindow);

const LOOP_BLOCK =
  "The answer is that the local model keeps producing the very same sentence over and over again here. "; // 100 chars

interface FakeStreamState {
  yielded: number;
  closedEarly: boolean;
}

/** Endless-ish degenerate text stream; records how far it got and whether it
 *  was torn down before finishing. */
function degenerateStream(state: FakeStreamState, deltas = 200) {
  return async function* () {
    try {
      for (let i = 0; i < deltas; i++) {
        state.yielded++;
        yield { type: "text" as const, delta: LOOP_BLOCK.slice(0, 50) };
        yield { type: "text" as const, delta: LOOP_BLOCK.slice(50) };
      }
      yield { type: "done" as const, stopReason: "stop" };
    } finally {
      if (state.yielded < deltas) state.closedEarly = true;
    }
  };
}

function req(baseURL: string): ProviderRequest {
  return {
    apiKey: "k",
    model: "test-model",
    baseURL,
    systemPrompt: "sys",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  };
}

function markerReports(reports: AdapterReport[]) {
  return reports.filter(
    (r) => r.kind === "stream_chunk" && (r.body as { stopped?: boolean } | null)?.stopped === true,
  );
}

beforeEach(() => {
  streamMock.mockReset();
  vi.mocked(markNoToolSupport).mockClear();
  // Deterministic default for every test; cap-threading tests override.
  mockWindow.mockReturnValue({ tokens: 1_000_000, provenance: "probed" });
});

describe("streamOnce degenerate guard", () => {
  it("local endpoint: trips, cuts the stream early, keeps partial text, emits ONE stopped marker", async () => {
    const state: FakeStreamState = { yielded: 0, closedEarly: false };
    streamMock.mockImplementation(degenerateStream(state));
    const reports: AdapterReport[] = [];

    const result = await streamOnce(req("http://127.0.0.1:11434/v1"), (r) => reports.push(r), {
      isAborted: () => false,
    });

    expect(result.stoppedByGuard).toMatch(/tail repetition/);
    expect(result.firstError).toBeNull();
    // Partial text preserved, but the stream did not run to completion.
    expect(result.assembledText.length).toBeGreaterThan(0);
    expect(result.assembledText.length).toBeLessThan(200 * LOOP_BLOCK.length);
    expect(state.closedEarly).toBe(true);

    const markers = markerReports(reports);
    expect(markers).toHaveLength(1);
    const body = markers[0].kind === "stream_chunk" ? (markers[0].body as Record<string, unknown>) : {};
    expect(body.reason).toBe(DEGENERATE_STREAM_STOP_REASON);
    expect(body.firedBy).toBe("stream-guard");
    expect(body.debug).toMatch(/tail repetition/);
  });

  it("cloud endpoint: guard is not armed — identical degenerate stream runs to completion", async () => {
    const state: FakeStreamState = { yielded: 0, closedEarly: false };
    streamMock.mockImplementation(degenerateStream(state, 30));
    const reports: AdapterReport[] = [];

    const result = await streamOnce(req("https://api.llm-cloud.example/v1"), (r) => reports.push(r), {
      isAborted: () => false,
    });

    expect(result.stoppedByGuard).toBeUndefined();
    expect(state.closedEarly).toBe(false);
    expect(state.yielded).toBe(30);
    expect(result.assembledText.length).toBe(30 * LOOP_BLOCK.length);
    expect(markerReports(reports)).toHaveLength(0);
  });
});

describe("runTurn on a guard-stopped stream", () => {
  it("ends the turn cleanly: done terminal, partial finalized, no retries, no error reports", async () => {
    const state: FakeStreamState = { yielded: 0, closedEarly: false };
    streamMock.mockImplementation(degenerateStream(state));
    const reports: AdapterReport[] = [];

    const adapter = createOpenAICompatAdapter({
      model: "test-model",
      baseURL: "http://127.0.0.1:11434/v1",
      apiKey: "k",
    });
    const result = await adapter.runTurn(
      {
        opId: "op-guard",
        turnIdx: 1,
        messages: [{ messageId: "m1", role: "user", content: { text: "hi" } }],
        tools: [{ name: "read_file", description: "read", inputSchema: { type: "object" } }],
      },
      (r) => reports.push(r),
    );

    // One transport call — no empty-response retry, no narration nudge.
    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(result.terminalReason).toBe("done");
    expect(vi.mocked(markNoToolSupport)).not.toHaveBeenCalled();

    expect(reports.filter((r) => r.kind === "error")).toHaveLength(0);
    expect(reports.filter((r) => r.kind === "tool_call_requested")).toHaveLength(0);
    expect(markerReports(reports)).toHaveLength(1);

    const finalized = reports.find((r) => r.kind === "message_finalized");
    expect(finalized).toBeDefined();
    if (finalized?.kind === "message_finalized") {
      const content = finalized.message.content as { text: string };
      expect(content.text.length).toBeGreaterThan(0);
    }
  });

  it("REGRESSION: nudge retry degenerates into a loop of VALID tool-call JSON — nothing is mined, nothing dispatches", async () => {
    // Turn 1: healthy prose NARRATION (no JSON, guard never trips on it) —
    // triggers the wire-format nudge retry with tool_choice:"required".
    const narration = "I will run the bash tool with the command ls to inspect the workspace first.";
    // Turn 2 (the retry): verbatim loop of a VALID bash tool call as JSON.
    const jsonUnit = '{"name":"bash","arguments":{"command":"ls"}}\n';
    async function* narrationStream() {
      yield { type: "text" as const, delta: narration };
      yield { type: "done" as const, stopReason: "stop" };
    }
    async function* degenerateJsonStream() {
      for (let i = 0; i < 60; i++) yield { type: "text" as const, delta: jsonUnit };
      yield { type: "done" as const, stopReason: "stop" };
    }
    streamMock.mockImplementationOnce(narrationStream).mockImplementationOnce(degenerateJsonStream);
    const reports: AdapterReport[] = [];

    const adapter = createOpenAICompatAdapter({
      model: "test-model",
      baseURL: "http://127.0.0.1:11434/v1",
      apiKey: "k",
    });
    const result = await adapter.runTurn(
      {
        opId: "op-nudge-guard",
        turnIdx: 1,
        messages: [{ messageId: "m1", role: "user", content: { text: "list the files" } }],
        tools: [{ name: "bash", description: "run a shell command", inputSchema: { type: "object" } }],
      },
      (r) => reports.push(r),
    );

    // The nudge retry DID fire (two transport calls) and the retry stream
    // guard-stopped.
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(markerReports(reports)).toHaveLength(1);
    expect(result.terminalReason).toBe("done");

    // The invariant under test: the degenerate retry text is provably
    // MINEABLE (positive control on the real extractor) — yet nothing was
    // mined, reported, or attached to the finalized message.
    const finalized = reports.find((r) => r.kind === "message_finalized");
    expect(finalized).toBeDefined();
    if (finalized?.kind === "message_finalized") {
      const content = finalized.message.content as { text: string; toolCalls?: unknown[] };
      expect(
        extractToolCallsFromText(content.text, new Set(["bash"])).toolCalls.length,
      ).toBeGreaterThan(0); // positive control: the gate, not extraction failure, kept this at zero
      expect(content.toolCalls).toBeUndefined();
      // Guard-stopped retries are not "persistent narration" either — the
      // stopped notice explains the cut; no annotation is appended.
      expect(content.text).not.toContain("[wire-format-error:");
    }
    expect(reports.filter((r) => r.kind === "tool_call_requested")).toHaveLength(0);
  });
});

describe("window-aware cap threading (runTurn → ProviderRequest)", () => {
  async function* cleanStream() {
    yield { type: "text" as const, delta: "hello" };
    yield { type: "done" as const, stopReason: "stop" };
  }

  async function runOnce(opts: { baseURL?: string; maxTokens?: number } = {}): Promise<ProviderRequest> {
    streamMock.mockImplementation(cleanStream);
    const adapter = createOpenAICompatAdapter({
      model: "test-model",
      baseURL: opts.baseURL ?? "http://127.0.0.1:11434/v1",
      apiKey: "k",
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    });
    await adapter.runTurn(
      {
        opId: "op-cap",
        turnIdx: 1,
        messages: [{ messageId: "m1", role: "user", content: { text: "hi" } }],
        tools: [],
      },
      () => {},
    );
    return streamMock.mock.calls[0][0] as ProviderRequest;
  }

  it("small PROBED window: the local default clamps below 16384 on the outbound request", async () => {
    mockWindow.mockReturnValue({ tokens: 8_192, provenance: "probed" });
    const sent = await runOnce();
    expect(typeof sent.maxTokens).toBe("number");
    expect(sent.maxTokens!).toBeLessThan(LOCAL_DEFAULT_MAX_TOKENS);
    expect(sent.maxTokens!).toBeGreaterThan(4_000); // tiny prompt: ~window − reserve
    expect(sent.omitDefaultMaxTokens).toBeUndefined();
  });

  it("PROBED window with no completion budget: cap omitted AND transport default suppressed", async () => {
    mockWindow.mockReturnValue({ tokens: 1_100, provenance: "probed" });
    const sent = await runOnce();
    expect(sent.maxTokens).toBeUndefined();
    expect(sent.omitDefaultMaxTokens).toBe(true);
  });

  it("FLOOR window (unloaded model): nothing clamped, nothing suppressed — the 16384 default applies downstream", async () => {
    mockWindow.mockReturnValue({ tokens: 8_192, provenance: "floor" });
    const sent = await runOnce();
    expect(sent.maxTokens).toBeUndefined();
    expect(sent.omitDefaultMaxTokens).toBeUndefined();
  });

  it("explicit cap: respected under a big window, clamped down under a small one, never raised", async () => {
    mockWindow.mockReturnValue({ tokens: 131_072, provenance: "probed" });
    expect((await runOnce({ maxTokens: 512 })).maxTokens).toBe(512);

    streamMock.mockReset();
    mockWindow.mockReturnValue({ tokens: 8_192, provenance: "probed" });
    const sent = await runOnce({ maxTokens: 16_000 });
    expect(sent.maxTokens!).toBeLessThan(16_000);
    expect(sent.maxTokens!).toBeGreaterThan(4_000);
  });
});
