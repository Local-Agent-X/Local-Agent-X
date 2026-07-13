import { describe, it, expect, vi, beforeEach } from "vitest";

const classifyWithLLM = vi.fn();
vi.mock("./classify-with-llm.js", () => ({
  classifyWithLLM: (...args: unknown[]) => classifyWithLLM(...args),
}));

const { classifyAppTierEscalation, parseTier, parseTierOrClarify } = await import("./app-tier-classify.js");
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

describe("parseTierOrClarify", () => {
  it("still parses plain tier tokens (delegates to parseTier)", () => {
    expect(parseTierOrClarify("FULL-STACK — shared reservations db")).toBe("full-stack");
    expect(parseTierOrClarify("quick-html, one page is honest")).toBe("quick-html");
  });

  it("parses a well-formed CLARIFY line into a clarify verdict", () => {
    const v = parseTierOrClarify(
      "CLARIFY | What do you mean by a mega computer? | A retro-computer web app | A simulated CPU in code | A real PC parts list",
    );
    expect(v).toEqual({
      kind: "clarify",
      question: "What do you mean by a mega computer?",
      options: ["A retro-computer web app", "A simulated CPU in code", "A real PC parts list"],
    });
  });

  it("is case-insensitive on the CLARIFY keyword and caps at 4 options", () => {
    const v = parseTierOrClarify("clarify | Q | a | b | c | d | e");
    expect(v).toMatchObject({ kind: "clarify", question: "Q", options: ["a", "b", "c", "d"] });
  });

  it("rejects a malformed CLARIFY (missing question or < 2 options) so the caller builds", () => {
    expect(parseTierOrClarify("CLARIFY")).toBeNull();
    expect(parseTierOrClarify("CLARIFY | only a question")).toBeNull();
    expect(parseTierOrClarify("CLARIFY | q | just-one-option")).toBeNull();
  });
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

  it("surfaces a clarify verdict from the quick-html residue instead of a tier", async () => {
    const clarify = {
      kind: "clarify",
      question: "What do you mean by a mega computer?",
      options: ["A retro-computer web app", "A real PC parts list"],
    };
    classifyWithLLM.mockResolvedValue(clarify);
    expect(await resolveAppTier("build me a mega computer")).toEqual(clarify);
  });
});
