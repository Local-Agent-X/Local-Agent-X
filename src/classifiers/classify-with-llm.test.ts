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

// classifyYesNo lives in classify-conveniences.ts and reaches call sites via
// this re-export — importing it from here doubles as the seam's regression test.
import { classifyYesNo, parseYesNoReason } from "./classify-with-llm.js";

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
    expect(mocks.warmModel).toHaveBeenCalledWith("http://127.0.0.1:11434", "llama3.2:3b");
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
