import { describe, expect, it } from "vitest";
import { toolCapTierForProvider, GEMINI_STRONG_TOOL_CAP, classifyModel } from "../src/model-tiers.js";

// Regression guard (live 2026-06-11): Gemini 2.5/3.x classify as "strong" tier,
// which has no tool cap — so LAX sent its OpenAI-compat endpoint all ~98 tools.
// Google documents a 10-20 active-tool ceiling; past it the endpoint returns
// empty STOP completions and the model narrates without ever calling a tool.
// Gemini-strong must cap at the medium count; every other provider is unchanged.
describe("toolCapTierForProvider — Gemini endpoint tool cap", () => {
  it("caps Gemini strong models to medium (the bug)", () => {
    expect(toolCapTierForProvider("gemini", "gemini-2.5-pro")).toBe("medium");
    expect(toolCapTierForProvider("gemini", "gemini-2.5-flash")).toBe("medium");
    expect(toolCapTierForProvider("gemini", "gemini-3.5-flash")).toBe("medium");
    // The effective cap is now GEMINI_STRONG_TOOL_CAP, not maxToolsForTier
    // ("medium") — the two were coincidentally both 21 and silently coupled
    // until 2026-07-15, so a medium bump for model-capacity reasons moved
    // Gemini's endpoint limit as a side effect. Assert the real number this
    // path passes to shrinkToolsForTier. NB: 21 was inherited, not tuned, and
    // is already a hair over Google's ≤20 guidance; tool_search covers the
    // rest. Kept as-is to hold behavior, not because 21 is proven optimal.
    expect(GEMINI_STRONG_TOOL_CAP).toBeLessThanOrEqual(21);
  });

  it("never RAISES a weak Gemini model's cap (gemini-2.0-flash stays weak)", () => {
    expect(classifyModel("gemini-2.0-flash")).toBe("weak");
    expect(toolCapTierForProvider("gemini", "gemini-2.0-flash")).toBe("weak");
  });

  it("leaves other providers' strong tier UNCAPPED (no behavior change)", () => {
    expect(toolCapTierForProvider("anthropic", "claude-opus-4-8")).toBe("strong");
    expect(toolCapTierForProvider("openai", "gpt-5.5")).toBe("strong");
    expect(toolCapTierForProvider("xai", "grok-4")).toBe("strong");
  });

  it("is a no-op (capTier===tier) for non-Gemini, so the selector skips the extra shrink", () => {
    for (const [provider, model] of [["anthropic", "claude-opus-4-8"], ["openai", "gpt-5.5"], ["xai", "grok-4"]] as const) {
      expect(toolCapTierForProvider(provider, model)).toBe(classifyModel(model));
    }
  });
});
