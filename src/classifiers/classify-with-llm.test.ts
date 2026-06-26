import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture what model the classifier actually dispatches. The registry is NOT
// mocked — we assert the real backgroundModelFor() wiring resolves grok-4.3
// (chat) down to grok-4.20-0309-non-reasoning (background).
const dispatchMock = vi.fn(async (_opts: Record<string, unknown>) => "NO — not a give-up");
vi.mock("../llm-dispatch.js", () => ({ dispatch: dispatchMock }));
vi.mock("../providers/resolve-provider-context.js", () => ({
  resolveProviderContext: vi.fn(async () => ({ provider: "xai", apiKey: "k", model: "grok-4.3" })),
}));

import { classifyYesNo } from "./classify-with-llm.js";

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
