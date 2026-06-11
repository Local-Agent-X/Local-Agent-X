import { describe, expect, it } from "vitest";
import { toolCapTierForProvider, maxToolsForTier, classifyModel } from "../src/model-tiers.js";

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
    // sanity: the cap is well under Google's ≤20 guidance
    expect(maxToolsForTier("medium")).toBeLessThanOrEqual(21);
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
