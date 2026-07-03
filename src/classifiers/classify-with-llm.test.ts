import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture what model the classifier actually dispatches. The registry is NOT
// mocked — we assert the real backgroundModelFor() wiring resolves grok-4.3
// (chat) down to grok-4.20-0309-non-reasoning (background).
const dispatchMock = vi.fn(async (_opts: Record<string, unknown>) => "NO — not a give-up");
vi.mock("../llm-dispatch.js", () => ({ dispatch: dispatchMock }));
vi.mock("../providers/resolve-provider-context.js", () => ({
  resolveProviderContext: vi.fn(async () => ({ provider: "xai", apiKey: "k", model: "grok-4.3" })),
}));

import { classifyYesNo, parseYesNoReason } from "./classify-with-llm.js";

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
