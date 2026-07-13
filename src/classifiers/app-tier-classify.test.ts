import { describe, it, expect, vi, beforeEach } from "vitest";

const classifyWithLLM = vi.fn();
vi.mock("./classify-with-llm.js", () => ({
  classifyWithLLM: (...args: unknown[]) => classifyWithLLM(...args),
}));

const { classifyAppTierEscalation, parseTier } = await import("./app-tier-classify.js");
const { resolveAppTier } = await import("../tools/app-tier.js");

beforeEach(() => classifyWithLLM.mockReset());

describe("parseTier", () => {
  it.each([
    ["FULL-STACK — needs a shared reservations database", "full-stack"],
    ["frontend-spa: login implies routing and state", "frontend-spa"],
    ["QUICK-HTML, a single page can honestly be this", "quick-html"],
    ["COMPILED-NATIVE because it names a Rust toolchain", "compiled-native"],
    ["  Full-Stack\nsecond line ignored", "full-stack"],
  ])("parses %j → %s", (raw, tier) => {
    expect(parseTier(raw)).toBe(tier);
  });

  it.each(["", "MAYBE full-stack?", "static page", "tier: unknown"])(
    "rejects non-tier reply %j",
    (raw) => {
      expect(parseTier(raw)).toBeNull();
    },
  );
});

describe("classifyAppTierEscalation", () => {
  it("passes the brief through the chokepoint with the app-tier env flag", async () => {
    classifyWithLLM.mockResolvedValue("full-stack");
    const verdict = await classifyAppTierEscalation({
      prompt: "a booking system for my car wash where customers reserve slots",
    });
    expect(verdict).toBe("full-stack");
    const opts = classifyWithLLM.mock.calls[0][0];
    expect(opts.category).toBe("app-tier");
    expect(opts.envDisableVar).toBe("LAX_LLM_APP_TIER");
    expect(opts.userPrompt).toContain("car wash");
  });

  it("returns null when the LLM is unavailable (caller keeps the regex verdict)", async () => {
    classifyWithLLM.mockResolvedValue(null);
    expect(await classifyAppTierEscalation({ prompt: "a tip calculator" })).toBeNull();
  });
});

describe("resolveAppTier — escalation-only hybrid", () => {
  it("trusts regex hard signals without consulting the LLM", async () => {
    classifyWithLLM.mockResolvedValue("quick-html");
    expect(await resolveAppTier("build a rust raytracer")).toBe("compiled-native");
    expect(classifyWithLLM).not.toHaveBeenCalled();
  });

  it("escalates the quick-html residue on an LLM verdict", async () => {
    classifyWithLLM.mockResolvedValue("full-stack");
    expect(await resolveAppTier("a booking system for my car wash")).toBe("full-stack");
  });

  it("keeps the regex verdict on LLM outage — never downgrades toward faking", async () => {
    classifyWithLLM.mockResolvedValue(null);
    expect(await resolveAppTier("a tip calculator")).toBe("quick-html");
  });
});
