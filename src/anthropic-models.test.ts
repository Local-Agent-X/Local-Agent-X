// Locks the Claude Sonnet 5 wiring. The load-bearing invariant is the
// adaptive-thinking gate: Sonnet 5 rejects budget_tokens/temperature with a
// 400, and the Anthropic request layer keys off anthropicUsesAdaptiveThinking
// to pick the request shape. If that regex ever drops sonnet-5, every Sonnet 5
// call 400s in production while unit-per-module tests stay green.

import { describe, it, expect } from "vitest";
import { normalizeAnthropicModel, anthropicUsesAdaptiveThinking } from "./anthropic-models.js";
import { classifyModel } from "./model-tiers.js";

describe("Claude Sonnet 5 wiring", () => {
  it("uses the adaptive-thinking request shape (the 400 guard)", () => {
    expect(anthropicUsesAdaptiveThinking("claude-sonnet-5")).toBe(true);
    expect(anthropicUsesAdaptiveThinking("anthropic/claude-sonnet-5")).toBe(true);
    expect(anthropicUsesAdaptiveThinking("claude-sonnet-5[1m]")).toBe(true);
  });

  it("does NOT misclassify sonnet-4-x as adaptive via the sonnet-5 rule", () => {
    expect(anthropicUsesAdaptiveThinking("claude-sonnet-4-5")).toBe(false);
  });

  it("normalizes aliases to the canonical id", () => {
    expect(normalizeAnthropicModel("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(normalizeAnthropicModel("anthropic/claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(normalizeAnthropicModel("claude-sonnet-5[1m]")).toBe("claude-sonnet-5");
    expect(normalizeAnthropicModel("Claude-Sonnet-5")).toBe("claude-sonnet-5");
  });

  it("classifies as a strong tool-use tier", () => {
    expect(classifyModel("claude-sonnet-5")).toBe("strong");
  });
});
