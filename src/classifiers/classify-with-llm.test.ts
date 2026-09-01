import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Capture what model the classifier actually dispatches. The registry is NOT
// mocked — we assert the real backgroundModelFor() wiring resolves grok-4.3
// (chat) down to grok-4.20-0309-non-reasoning (background).
const dispatchMock = vi.fn(async (_opts: Record<string, unknown>) => "NO — not a give-up");
vi.mock("../llm-dispatch.js", () => ({ dispatch: dispatchMock }));

// Provider context + residency are swappable per test. vi.hoisted because,
// unlike llm-dispatch (lazily imported by the module under test), these are
// STATIC imports — their mock factories run while the module graph loads.
const mocks = vi.hoisted(() => ({
  ctx: { provider: "xai", apiKey: "k", model: "grok-4.3" },
  isModelResident: vi.fn(async (): Promise<boolean | null> => null),
  warmModel: vi.fn(),
}));
vi.mock("../providers/resolve-provider-context.js", () => ({
  resolveProviderContext: vi.fn(async () => mocks.ctx),
}));
vi.mock("../local-runtimes/residency.js", () => ({
  isModelResident: mocks.isModelResident,
  warmModel: mocks.warmModel,
}));

// The codex client is lazily imported by the branch under test, so the mock
// factory runs at first classify call. Capture the exact params handed to
// streamCodexResponse — the signal + effort assertions below read them back.
const codexMock = vi.hoisted(() => ({ streamCodexResponse: vi.fn() }));
vi.mock("../codex-client/index.js", () => ({
  streamCodexResponse: codexMock.streamCodexResponse,
}));

// classifyYesNo lives in classify-conveniences.ts and reaches call sites via
// this re-export — importing it from here doubles as the seam's regression test.
import { classifyWithLLM, classifyYesNo, parseYesNoReason } from "./classify-with-llm.js";
// Type-only: erased at runtime, so the vi.mock above stays the only thing
// this file loads from the codex client. Keeps the captured-params type
// honest against the real signature instead of a hand-written copy.
import type { streamCodexResponse } from "../codex-client/index.js";
type CodexCallParams = Parameters<typeof streamCodexResponse>[0];

// Pin the ollama base URL — with a trailing slash, deliberately — so the
// cold-skip tests can assert the exact NORMALIZED baseUrl handed to
// warmModel. Set at module top: getRuntimeConfig() caches on first call in
// this fork, and nothing reads it before the tests run.
process.env.LAX_OLLAMA_URL = "http://127.0.0.1:11434/";

describe("classify-with-llm model selection", () => {
  beforeEach(() => dispatchMock.mockClear());

  it("runs on the provider's background model, not the user's reasoning chat model", async () => {
    // Regression for 2026-06-26: classifiers inherited grok-4.3 (a reasoner)
    // and timed out every call, so the give-up verdict never ran on Grok.
    await classifyYesNo({ category: "test", systemPrompt: "s", userPrompt: "u", timeoutMs: 2000 });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0][0]).toMatchObject({
      provider: "xai",
      xaiModel: "grok-4.20-0309-non-reasoning",
    });
  });

  it("honors an explicit per-call model override", async () => {
    await classifyYesNo({
      category: "test", systemPrompt: "s", userPrompt: "u", timeoutMs: 2000, model: "grok-code-fast-1",
    });
    expect(dispatchMock.mock.calls[0][0]).toMatchObject({ xaiModel: "grok-code-fast-1" });
  });
});

describe("classify-with-llm local cold-skip", () => {
  beforeEach(() => {
    dispatchMock.mockClear();
    // mockReset (not mockClear): restores the base `null` implementation and
    // drops any unconsumed mockResolvedValueOnce queued by a prior test.
    mocks.isModelResident.mockReset();
    mocks.warmModel.mockClear();
    mocks.ctx = { provider: "local", apiKey: "", model: "qwen3.6:27b" };
  });
  afterEach(() => {
    mocks.ctx = { provider: "xai", apiKey: "k", model: "grok-4.3" };
  });

  it("model not resident → no dispatch, warm fired, instant timeout-style null", async () => {
    // Regression for the cold-start burn: first local call after idle spent
    // its whole 3s wallclock on a 16.5s model load and nulled out anyway.
    // Cold-skip must produce the SAME degrade (null → caller's regex verdict)
    // without a wire call, and warm the exact model it skipped at the exact
    // configured base (normalized — the pinned env URL has a trailing slash).
    mocks.isModelResident.mockResolvedValueOnce(false);
    const out = await classifyYesNo({
      category: "test", systemPrompt: "s", userPrompt: "u", timeoutMs: 2000, model: "llama3.2:3b",
    });
    expect(out).toBeNull();
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(mocks.warmModel).toHaveBeenCalledTimes(1);
    // The warm must carry the dispatch num_ctx: it fixes the loaded KV size,
    // and a default-window warm (131k auto) pins 8x the VRAM the real
    // DISPATCH_NUM_CTX call needs.
    expect(mocks.warmModel).toHaveBeenCalledWith("http://127.0.0.1:11434", "llama3.2:3b", undefined, 16_384);
  });

  it("long-budget callers proceed even when cold — they can afford the load", async () => {
    // Compaction-class budgets (30s) fit a 16.5s cold load with room to
    // answer; they must keep getting a REAL verdict, exactly as before the
    // cold-skip existed. The budget gate short-circuits ahead of the probe,
    // so residency is never even consulted — no skip, no warm, no /api/ps.
    mocks.isModelResident.mockResolvedValue(false); // even a cold model must not trigger a skip
    dispatchMock.mockResolvedValueOnce("YES");
    const out = await classifyYesNo({
      category: "test", systemPrompt: "s", userPrompt: "u", timeoutMs: 30_000, model: "llama3.2:3b",
    });
    expect(out).toBe(true);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(mocks.isModelResident).not.toHaveBeenCalled();
    expect(mocks.warmModel).not.toHaveBeenCalled();
  });

  it("residency unknown (null) → dispatch proceeds exactly as before", async () => {
    mocks.isModelResident.mockResolvedValueOnce(null);
    dispatchMock.mockResolvedValueOnce("YES");
    const out = await classifyYesNo({
      category: "test", systemPrompt: "s", userPrompt: "u", timeoutMs: 2000, model: "llama3.2:3b",
    });
    expect(out).toBe(true);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0][0]).toMatchObject({ provider: "ollama", ollamaModel: "llama3.2:3b" });
    expect(mocks.warmModel).not.toHaveBeenCalled();
  });

  it("model resident → dispatch proceeds, no warm", async () => {
    mocks.isModelResident.mockResolvedValueOnce(true);
    dispatchMock.mockResolvedValueOnce("NO");
    const out = await classifyYesNo({
      category: "test", systemPrompt: "s", userPrompt: "u", timeoutMs: 2000, model: "llama3.2:3b",
    });
    expect(out).toBe(false);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(mocks.warmModel).not.toHaveBeenCalled();
  });

  it("non-local providers never consult residency", async () => {
    mocks.ctx = { provider: "xai", apiKey: "k", model: "grok-4.3" };
    await classifyYesNo({ category: "test", systemPrompt: "s", userPrompt: "u", timeoutMs: 2000 });
    expect(mocks.isModelResident).not.toHaveBeenCalled();
  });
});

describe("classify-with-llm codex branch", () => {
  const yieldText = (delta: string) => (async function* () {
    yield { type: "text", delta };
  })();
  const parse = (raw: string) => raw.trim();

  beforeEach(() => {
    codexMock.streamCodexResponse.mockReset();
    mocks.ctx = { provider: "codex", apiKey: "tok", model: "gpt-5.5" };
  });
  afterEach(() => {
    mocks.ctx = { provider: "xai", apiKey: "k", model: "grok-4.3" };
  });

  it("timeout budget aborts the signal handed to the codex stream", async () => {
    // Regression for the orphaned-stream quota burn: a classifier whose
    // budget expired used to leave its codex stream running to completion
    // (no signal was passed), so every `wallclock timeout (provider=codex)`
    // still billed a full reasoning pass. The stream below never yields
    // until it observes an abort — the hung-upstream case the budget exists
    // for. Path exercised: the abort timer (registered before the wallclock
    // timer, same delay) fires first, the stream rejects with AbortError, and
    // the wrapper returns null via its catch path. The wallclock sentinel is
    // reached only when a stream ignores the abort — by then that same timer
    // has already aborted this signal.
    codexMock.streamCodexResponse.mockImplementationOnce((params: CodexCallParams) =>
      (async function* () {
        const signal = params.signal;
        if (!signal) return;
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new DOMException("aborted", "AbortError");
      })(),
    );
    const out = await classifyWithLLM({
      category: "test", systemPrompt: "s", userPrompt: "u", timeoutMs: 40, parse,
    });
    expect(out).toBeNull();
    expect(codexMock.streamCodexResponse).toHaveBeenCalledTimes(1);
    const params: CodexCallParams = codexMock.streamCodexResponse.mock.calls[0][0];
    expect(params.signal).toBeInstanceOf(AbortSignal);
    expect(params.signal?.aborted).toBe(true);
  });

  it("background tier (default) runs the registry background model at low effort", async () => {
    // gpt-5.4-mini authoring a yes/no verdict inside a seconds-long budget:
    // the client's chat default "medium" is a reasoning pass for nothing —
    // and the latency that pushed calls past the wallclock to begin with.
    codexMock.streamCodexResponse.mockImplementationOnce(() => yieldText("NO"));
    const out = await classifyWithLLM({
      category: "test", systemPrompt: "s", userPrompt: "u", timeoutMs: 2000, parse,
    });
    expect(out).toBe("NO");
    const params: CodexCallParams = codexMock.streamCodexResponse.mock.calls[0][0];
    expect(params.model).toBe("gpt-5.4-mini");
    expect(params.reasoningEffort).toBe("low");
  });

  it("a budget at the 8000ms default still runs at low effort", async () => {
    // Every evidenced codex wallclock timeout ran on a budget <= the 8000ms
    // DEFAULT_TIMEOUT_MS; the boundary itself must stay on the fast path.
    codexMock.streamCodexResponse.mockImplementationOnce(() => yieldText("NO"));
    await classifyWithLLM({ category: "test", systemPrompt: "s", userPrompt: "u", timeoutMs: 8000, parse });
    const params: CodexCallParams = codexMock.streamCodexResponse.mock.calls[0][0];
    expect(params.reasoningEffort).toBe("low");
  });

  it("a long budget keeps the client's default effort even on the background tier", async () => {
    // Long-budget callers pass no tier but bought the time for a considered
    // answer (scenario-judge 20s, compaction 30s — whose summary is persisted
    // over history). Budget is the only signal they give; honor it.
    codexMock.streamCodexResponse.mockImplementationOnce(() => yieldText("YES"));
    await classifyWithLLM({ category: "test", systemPrompt: "s", userPrompt: "u", timeoutMs: 20_000, parse });
    const params: CodexCallParams = codexMock.streamCodexResponse.mock.calls[0][0];
    expect(params.model).toBe("gpt-5.4-mini");
    expect(params.reasoningEffort).toBeUndefined();
  });

  it("active tier keeps the chat model's effort untouched", async () => {
    // "active" is opted into BECAUSE output quality matters (probe authoring,
    // done-claim audit). The classifier must not quietly downgrade it.
    codexMock.streamCodexResponse.mockImplementationOnce(() => yieldText("YES"));
    const out = await classifyWithLLM({
      category: "test", systemPrompt: "s", userPrompt: "u", timeoutMs: 2000, parse, modelTier: "active",
    });
    expect(out).toBe("YES");
    const params: CodexCallParams = codexMock.streamCodexResponse.mock.calls[0][0];
    expect(params.model).toBe("gpt-5.5");
    expect(params.reasoningEffort).toBeUndefined();
  });
});

describe("parseYesNoReason", () => {
  it("splits verdict from reason across common separators", () => {
    expect(parseYesNoReason("YES — the build is broken")).toEqual({ verdict: true, reason: "the build is broken" });
    expect(parseYesNoReason("NO. it holds up fine")).toEqual({ verdict: false, reason: "it holds up fine" });
    expect(parseYesNoReason("yes: missing a test")).toEqual({ verdict: true, reason: "missing a test" });
    expect(parseYesNoReason("No - nothing wrong")).toEqual({ verdict: false, reason: "nothing wrong" });
  });

  it("captures the verdict even with no reason", () => {
    expect(parseYesNoReason("NO")).toEqual({ verdict: false, reason: "" });
    expect(parseYesNoReason("  YES  ")).toEqual({ verdict: true, reason: "" });
  });

  it("collapses whitespace and caps the reason length", () => {
    expect(parseYesNoReason("YES   the   reason\n has  gaps")).toEqual({ verdict: true, reason: "the reason has gaps" });
    const long = "YES " + "x".repeat(400);
    expect(parseYesNoReason(long)!.reason.length).toBe(240);
  });

  it("returns null when the reply does not start with a verdict", () => {
    expect(parseYesNoReason("maybe, not sure")).toBeNull();
    expect(parseYesNoReason("")).toBeNull();
    expect(parseYesNoReason("the answer is YES")).toBeNull(); // verdict must lead
  });
});
