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

describe("Claude Opus 5 wiring", () => {
  it("uses the adaptive-thinking request shape (the 400 guard)", () => {
    expect(anthropicUsesAdaptiveThinking("claude-opus-5")).toBe(true);
    expect(anthropicUsesAdaptiveThinking("anthropic/claude-opus-5")).toBe(true);
    expect(anthropicUsesAdaptiveThinking("claude-opus-5[1m]")).toBe(true);
  });

  // The opus-5 branch sits next to opus-4-[678] in the same alternation, so the
  // regression to guard is opus-5 swallowing 4.5 (a legacy-shape model that
  // still needs budget_tokens/temperature) or the 4.x ids losing their shape.
  it("does NOT misclassify opus-4-5 as adaptive via the opus-5 rule", () => {
    expect(anthropicUsesAdaptiveThinking("claude-opus-4-5")).toBe(false);
  });

  it("keeps the 4.8/4.7 adaptive shape intact", () => {
    expect(anthropicUsesAdaptiveThinking("claude-opus-4-8")).toBe(true);
    expect(anthropicUsesAdaptiveThinking("claude-opus-4-7")).toBe(true);
  });

  it("normalizes aliases to the canonical id", () => {
    expect(normalizeAnthropicModel("claude-opus-5")).toBe("claude-opus-5");
    expect(normalizeAnthropicModel("anthropic/claude-opus-5")).toBe("claude-opus-5");
    expect(normalizeAnthropicModel("claude-opus-5[1m]")).toBe("claude-opus-5");
    expect(normalizeAnthropicModel("Claude-Opus-5")).toBe("claude-opus-5");
  });

  it("does not rewrite 4.8 — it is still an active model, not retired", () => {
    expect(normalizeAnthropicModel("claude-opus-4-8")).toBe("claude-opus-4-8");
  });

  it("classifies as a strong tool-use tier", () => {
    expect(classifyModel("claude-opus-5")).toBe("strong");
  });
});
