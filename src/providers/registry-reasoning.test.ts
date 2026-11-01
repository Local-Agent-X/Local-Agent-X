// isReasoningModel is the one answer to "does this model think": both Gemini
// adapters (chat-runner/register-adapter.ts, provider-adapter-factory.ts) ask
// it before requesting the thought stream, which is also what keeps the idle
// watchdog fed while the model thinks. Their own copies of the pattern missed
// gemini-4-argon, so it ran with no thought stream at all.
import { describe, expect, it } from "vitest";
import { PROVIDERS, isReasoningModel } from "./registry.js";

describe("isReasoningModel — Gemini", () => {
  it("every Gemini model the picker offers is a reasoning model", () => {
    const models = (PROVIDERS.gemini as { models: string[] }).models;
    expect(models).toContain("gemini-4-argon");
    for (const model of models) expect(isReasoningModel("gemini", model), model).toBe(true);
  });

  it("a pre-2.5 Gemini is not", () => {
    expect(isReasoningModel("gemini", "gemini-2.0-flash")).toBe(false);
    expect(isReasoningModel("gemini", "gemini-1.5-pro")).toBe(false);
  });
});
