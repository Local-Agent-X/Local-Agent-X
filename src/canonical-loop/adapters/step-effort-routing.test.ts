// Per-step reasoning-effort routing at the adapter choke points. A
// `stepEffortHint: "mechanical"` on TurnInput must LOWER the effort placed on
// the outgoing request to min(sessionEffort, adapterCeiling) — "low" for
// openai-compat, "medium" for codex (its endpoint empties at "low"); an
// absent hint must leave the session effort untouched; a session already
// below the ceiling must never be up-shifted. The classifier that produces
// the hint is tested in ../step-effort.test.ts — these pin the wire seam only.
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
vi.mock("../../providers/tool-capability-probe.js", () => ({
  maybeVerifyToolSupport: vi.fn(),
  noteLiveToolCallEvidence: vi.fn(),
}));

import { createOpenAICompatAdapter } from "./openai-compat.js";
import { CodexAdapter } from "./codex.js";
import type { CodexTransport } from "./codex-transport.js";
import { streamOnce } from "./openai-compat/stream-once.js";
import { resolveContextWindow } from "../../context-manager/model-windows.js";
import type { TurnInput } from "../adapter-contract.js";
import type { ReasoningEffort } from "../../providers/reasoning-effort.js";
import type { StreamOnceResult } from "./openai-compat/types.js";

const mockStream = vi.mocked(streamOnce);
const mockWindow = vi.mocked(resolveContextWindow);

function cleanResult(): StreamOnceResult {
  return {
    assembledText: "done",
    assembledThinking: "",
    pendingToolCalls: [],
    firstError: null,
    providerStop: "stop",
    usagePromptTokens: 10,
    usageCompletionTokens: 5,
    interruptedByInject: false,
  };
}

function makeInput(stepEffortHint?: "mechanical"): TurnInput {
  return {
    opId: "op-se",
    turnIdx: 2, // past turn 0 so no forced-tool interplay
    messages: [{ messageId: "m1", role: "user", content: { text: "continue" } }],
    tools: [],
    ...(stepEffortHint ? { stepEffortHint } : {}),
  };
}

describe("openai-compat per-step effort routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStream.mockResolvedValue(cleanResult());
    mockWindow.mockReturnValue({ tokens: 128_000, provenance: "probed" as const });
  });

  function makeAdapter(reasoningEffort?: ReasoningEffort) {
    return createOpenAICompatAdapter({
      model: "gpt-5",
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-test",
      reasoningEffort,
    });
  }

  it("a mechanical hint lowers the effort on the outgoing request to low", async () => {
    await makeAdapter("high").runTurn(makeInput("mechanical"), () => {});
    expect(mockStream).toHaveBeenCalledTimes(1);
    expect(mockStream.mock.calls[0][0].reasoningEffort).toBe("low");
  });

  it("a standard step (no hint) leaves the session effort untouched", async () => {
    await makeAdapter("high").runTurn(makeInput(), () => {});
    expect(mockStream.mock.calls[0][0].reasoningEffort).toBe("high");
  });

  it("never up-shifts: a minimal session stays minimal on a mechanical step", async () => {
    await makeAdapter("minimal").runTurn(makeInput("mechanical"), () => {});
    expect(mockStream.mock.calls[0][0].reasoningEffort).toBe("minimal");
  });

  it("no configured session effort: standard stays absent, mechanical caps the default", async () => {
    await makeAdapter(undefined).runTurn(makeInput(), () => {});
    expect(mockStream.mock.calls[0][0].reasoningEffort).toBeUndefined();
    await makeAdapter(undefined).runTurn(makeInput("mechanical"), () => {});
    expect(mockStream.mock.calls[1][0].reasoningEffort).toBe("low");
  });
});

describe("codex per-step effort routing", () => {
  function capturingTransport(captured: Array<{ reasoningEffort?: ReasoningEffort }>): CodexTransport {
    return {
      async *stream(req: { reasoningEffort?: ReasoningEffort }) {
        captured.push(req);
        yield { type: "text", delta: "done" };
        yield { type: "done" };
      },
    } as unknown as CodexTransport;
  }

  it("a mechanical hint caps the effort handed to the transport at MEDIUM — codex-specific ceiling", async () => {
    // NOT the default "low" ceiling: the Codex subscription endpoint measured
    // ~40% empty responses at "low" (codex-client/request.ts:72-73), and the
    // adapter's empty-turn recovery retries reuse the same capped req before
    // dying as a false "session expired" — so codex floors at "medium".
    const captured: Array<{ reasoningEffort?: ReasoningEffort }> = [];
    const adapter = new CodexAdapter({
      transport: capturingTransport(captured),
      model: "gpt-5.5",
      reasoningEffort: "high",
    });
    await adapter.runTurn(makeInput("mechanical"), () => {});
    expect(captured).toHaveLength(1);
    expect(captured[0].reasoningEffort).toBe("medium");
  });

  it("never up-shifts to the medium ceiling: a low session stays low on a mechanical step", async () => {
    const captured: Array<{ reasoningEffort?: ReasoningEffort }> = [];
    const adapter = new CodexAdapter({
      transport: capturingTransport(captured),
      model: "gpt-5.5",
      reasoningEffort: "low",
    });
    await adapter.runTurn(makeInput("mechanical"), () => {});
    expect(captured[0].reasoningEffort).toBe("low");
  });

  it("a standard step passes the session effort through untouched", async () => {
    const captured: Array<{ reasoningEffort?: ReasoningEffort }> = [];
    const adapter = new CodexAdapter({
      transport: capturingTransport(captured),
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
    });
    await adapter.runTurn(makeInput(), () => {});
    expect(captured[0].reasoningEffort).toBe("xhigh");
  });

  it("never up-shifts: a minimal session stays minimal on a mechanical step", async () => {
    const captured: Array<{ reasoningEffort?: ReasoningEffort }> = [];
    const adapter = new CodexAdapter({
      transport: capturingTransport(captured),
      model: "gpt-5.5",
      reasoningEffort: "minimal",
    });
    await adapter.runTurn(makeInput("mechanical"), () => {});
    expect(captured[0].reasoningEffort).toBe("minimal");
  });
});
