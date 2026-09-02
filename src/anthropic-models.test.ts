// Locks the Claude Sonnet 5 wiring. The load-bearing invariant is the
// adaptive-thinking gate: Sonnet 5 rejects budget_tokens/temperature with a
// 400, and the Anthropic request layer keys off anthropicUsesAdaptiveThinking
// to pick the request shape. If that regex ever drops sonnet-5, every Sonnet 5
// call 400s in production while unit-per-module tests stay green.

import { describe, it, expect } from "vitest";
import { normalizeAnthropicModel, anthropicUsesAdaptiveThinking, anthropicMaxOutputTokens } from "./anthropic-models.js";
import { classifyModel } from "./model-tiers.js";
import { PROVIDERS } from "./providers/registry.js";

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

describe("anthropicMaxOutputTokens — per-model output ceiling (single source of truth)", () => {
  it("returns 128K for the current Opus/Sonnet/Fable tiers, incl. Opus 5", () => {
    for (const m of [
      "claude-opus-5", "claude-opus-4-8", "claude-opus-4-6",
      "claude-sonnet-5", "claude-sonnet-4-6", "claude-fable-5",
    ]) {
      expect(anthropicMaxOutputTokens(m)).toBe(128_000);
    }
  });

  it("returns 64K for Haiku 4.5 (the one current model with a lower cap)", () => {
    expect(anthropicMaxOutputTokens("claude-haiku-4-5")).toBe(64_000);
  });

  it("resolves aliases before looking up the ceiling", () => {
    expect(anthropicMaxOutputTokens("anthropic/claude-opus-5")).toBe(128_000);
    expect(anthropicMaxOutputTokens("claude-opus-5[1m]")).toBe(128_000);
    expect(anthropicMaxOutputTokens("Claude-Opus-5")).toBe(128_000);
  });

  it("falls back to the 8192 floor for unknown / pre-4.5 ids — never truncates worse than the old default", () => {
    expect(anthropicMaxOutputTokens("claude-opus-4-0")).toBe(8_192);
    expect(anthropicMaxOutputTokens("some-unknown-model-xyz")).toBe(8_192);
  });

  it("is never below the legacy 8192 for any input (regression: the fix must not lower a ceiling)", () => {
    for (const m of ["claude-opus-5", "claude-haiku-4-5", "claude-opus-4-0", "", "garbage"]) {
      expect(anthropicMaxOutputTokens(m)).toBeGreaterThanOrEqual(8_192);
    }
  });
});

// claude-sonnet-4-7 never existed: the Sonnet line went 4.5 → 4.6 → 5, and the
// 4.7/4.8 generation is Opus-only. The tables briefly listed it anyway, which
// made normalizeAnthropicModel MANUFACTURE the phantom runtime id from user
// input ("claude-sonnet-4.7" → "claude-sonnet-4-7" → wire 404) — the one thing
// the "normalization never invents a model" contract forbids. Pin its absence
// from every table, and pin that the registry catalog carries no phantom: every
// offered id is a runtime id with a real per-model output ceiling.
describe("phantom claude-sonnet-4-7 stays out of the model tables", () => {
  it("normalization passes the unknown id through untouched instead of inventing a runtime id", () => {
    expect(normalizeAnthropicModel("claude-sonnet-4-7")).toBe("claude-sonnet-4-7");
    expect(normalizeAnthropicModel("claude-sonnet-4.7")).toBe("claude-sonnet-4.7");
    expect(normalizeAnthropicModel("anthropic/claude-sonnet-4.7")).toBe("claude-sonnet-4.7");
  });

  it("gets the unknown-model output floor, not a real model's 128K ceiling", () => {
    expect(anthropicMaxOutputTokens("claude-sonnet-4-7")).toBe(8_192);
  });

  it("its real neighbors keep their ceilings (removal touched only the phantom)", () => {
    expect(anthropicMaxOutputTokens("claude-sonnet-4-6")).toBe(128_000);
    expect(anthropicMaxOutputTokens("claude-sonnet-4-5")).toBe(128_000);
  });

  it("the registry catalog never offered it, and every offered id is a real runtime id", () => {
    const catalog = PROVIDERS.anthropic.models;
    expect(catalog).not.toContain("claude-sonnet-4-7");
    for (const id of catalog) {
      expect(normalizeAnthropicModel(id)).toBe(id);
      expect(anthropicMaxOutputTokens(id)).toBeGreaterThan(8_192);
    }
  });
});
