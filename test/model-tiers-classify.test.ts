/**
 * Regression guard for the model-tier classifier and tool-catalog shrinker
 * in src/model-tiers.ts.
 *
 * classifyModel is a name-heuristic that decides how much rope a model gets
 * (tool-catalog size, loop budget). The load-bearing distinctions:
 *   - claude-haiku-4-5-* is STRONG (the (?!-4-5) negative lookahead keeps it
 *     out of the weak bucket), while legacy 3.x haiku is WEAK.
 *   - grok-3-mini is WEAK, grok-3 is MEDIUM, grok-4 / grok-4-fast are STRONG.
 *   - opus/sonnet 4.x are STRONG; unknown names fall through to MEDIUM.
 *   - empty/missing identifier throws (fail-closed, caller bug).
 *
 * shrinkToolsForTier caps the catalog per tier: weak → 8, strong → unbounded.
 */

import { describe, expect, it } from "vitest";

import {
  classifyModel,
  shrinkToolsForTier,
  maxToolsForTier,
  ESSENTIAL_TOOLS_ORDER,
} from "../src/model-tiers.js";

describe("classifyModel — tier heuristic", () => {
  it("classifies claude-haiku-4-5-* as strong (the -4-5 lookahead keeps it out of weak)", () => {
    expect(classifyModel("claude-haiku-4-5")).toBe("strong");
    expect(classifyModel("claude-haiku-4-5-20251001")).toBe("strong");
  });

  it("classifies legacy 3.x haiku as weak", () => {
    expect(classifyModel("claude-3-5-haiku-20241022")).toBe("weak");
    expect(classifyModel("claude-3-haiku")).toBe("weak");
  });

  it("classifies grok variants by tier", () => {
    expect(classifyModel("grok-3-mini")).toBe("weak");
    expect(classifyModel("grok-3")).toBe("medium");
    expect(classifyModel("grok-4")).toBe("strong");
    expect(classifyModel("grok-4-fast")).toBe("strong");
  });

  it("classifies opus/sonnet 4.x as strong", () => {
    expect(classifyModel("claude-opus-4-1")).toBe("strong");
    expect(classifyModel("claude-opus-4")).toBe("strong");
    expect(classifyModel("claude-sonnet-4-6")).toBe("strong");
  });

  it("classifies small local models as weak", () => {
    expect(classifyModel("qwen2:7b")).toBe("weak");
    expect(classifyModel("llama3:8b")).toBe("weak");
  });

  it("is case-insensitive", () => {
    expect(classifyModel("GROK-4")).toBe("strong");
    expect(classifyModel("Claude-Opus-4-1")).toBe("strong");
  });

  it("falls through to medium for unknown model names", () => {
    expect(classifyModel("some-random-model")).toBe("medium");
    expect(classifyModel("mistral-large-2411")).toBe("medium");
  });

  it("throws on empty/missing identifier (fail-closed, caller bug)", () => {
    expect(() => classifyModel("")).toThrow(/empty\/missing model identifier/);
  });
});

describe("shrinkToolsForTier — per-tier catalog cap", () => {
  // Build a catalog of 30 named tools: the essentials plus filler. Filler
  // names are guaranteed not to collide with ESSENTIAL_TOOLS_ORDER.
  const makeCatalog = () => {
    const essentials = ESSENTIAL_TOOLS_ORDER.map((name) => ({
      name,
      description: `Essential tool ${name} with a reasonably long description that exceeds the weak-tier truncation threshold of one hundred and fifty characters so we can also exercise the description shortening path.`,
    }));
    const filler = Array.from({ length: 30 - essentials.length }, (_, i) => ({
      name: `filler_tool_${i}`,
      description: `Filler tool number ${i}.`,
    }));
    return [...essentials, ...filler];
  };

  it("caps the weak tier at maxToolsForTier('weak') (8)", () => {
    expect(maxToolsForTier("weak")).toBe(8);
    const out = shrinkToolsForTier(makeCatalog(), "weak");
    expect(out.length).toBe(8);
  });

  it("weak-tier kept set is drawn from the essentials priority order", () => {
    const out = shrinkToolsForTier(makeCatalog(), "weak");
    const expected = ESSENTIAL_TOOLS_ORDER.slice(0, 8);
    expect(out.map((t) => t.name)).toEqual([...expected]);
  });

  it("strong tier leaves the catalog full (no cap)", () => {
    expect(maxToolsForTier("strong")).toBe(Number.MAX_SAFE_INTEGER);
    const catalog = makeCatalog();
    const out = shrinkToolsForTier(catalog, "strong");
    expect(out.length).toBe(catalog.length);
    expect(out.map((t) => t.name)).toEqual(catalog.map((t) => t.name));
  });

  it("a catalog at or under the cap is returned intact", () => {
    const small = [
      { name: "read", description: "Read a file." },
      { name: "write", description: "Write a file." },
    ];
    const out = shrinkToolsForTier(small, "weak");
    expect(out.map((t) => t.name)).toEqual(["read", "write"]);
  });

  it("weak tier truncates long descriptions; strong tier leaves them intact", () => {
    const longDesc =
      "Read a file from disk and return its full contents as a UTF-8 string. " +
      "This description is intentionally written to be well over one hundred and fifty characters long.";
    const tools = [{ name: "read", description: longDesc }];

    const weak = shrinkToolsForTier(tools, "weak");
    expect(weak[0].description.length).toBeLessThan(longDesc.length);

    const strong = shrinkToolsForTier(tools, "strong");
    expect(strong[0].description).toBe(longDesc);
  });
});
