import { describe, it, expect } from "vitest";
import {
  hasNegation,
  asymmetricOverlap,
  findContradictions,
  OVERLAP_THRESHOLD,
} from "../src/memory/contradiction-sweep.js";
import { tokenizeStrict } from "../src/memory/text-utils.js";

describe("hasNegation", () => {
  it("flags explicit negations", () => {
    expect(hasNegation("no Spanish greetings")).toBe(true);
    expect(hasNegation("do not greet in Spanish")).toBe(true);
    expect(hasNegation("never use dark mode")).toBe(true);
    expect(hasNegation("don't ask")).toBe(true);
    expect(hasNegation("dont ask")).toBe(true);
    expect(hasNegation("stop greeting in Spanish")).toBe(true);
    expect(hasNegation("no longer wants Spanish")).toBe(true);
    expect(hasNegation("avoid corporate filler")).toBe(true);
  });

  it("does not flag plain affirmatives", () => {
    expect(hasNegation("Always greet Alex in Spanish")).toBe(false);
    expect(hasNegation("Use English by default")).toBe(false);
    expect(hasNegation("Match Alex's energy")).toBe(false);
  });
});

describe("asymmetricOverlap", () => {
  it("returns 0 when either set is empty", () => {
    expect(asymmetricOverlap(new Set(), new Set(["a"]))).toBe(0);
    expect(asymmetricOverlap(new Set(["a"]), new Set())).toBe(0);
  });

  it("uses min-size denominator (not Jaccard)", () => {
    const a = new Set(["x", "y"]);
    const b = new Set(["x", "y", "z", "w", "v"]);
    // Jaccard would be 2/5 = 0.4; asymmetric is 2/min(2,5) = 1.0
    expect(asymmetricOverlap(a, b)).toBe(1.0);
  });
});

describe("findContradictions — the live HEART.md case", () => {
  it("flags 'Always greet in Spanish' as contradicting 'No Spanish greetings'", () => {
    const items = [
      {
        text: "Use English by default. No Spanish greetings unless Alex explicitly switches to Spanish or asks for them.",
        payload: "A",
      },
      {
        text: "Always greet Alex in Spanish at the start of every conversation (e.g. 'Hola Alex', 'Qué tal, Alex', 'Buenas, Alex'). After the greeting, continue in English unless he switches to Spanish.",
        payload: "B",
      },
    ];
    const pairs = findContradictions(items);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].keep).toBe("A"); // negation wins
    expect(pairs[0].drop).toBe("B"); // affirmative dropped
    expect(pairs[0].overlap).toBeGreaterThanOrEqual(OVERLAP_THRESHOLD);
  });

  it("flags 'Always greet in Spanish' against 'Do not greet in Spanish'", () => {
    const items = [
      { text: "Do not greet Alex in Spanish by default. Use English unless he explicitly speaks Spanish.", payload: "negation" },
      { text: "Always greet Alex in Spanish at the start of every conversation.", payload: "affirm" },
    ];
    const pairs = findContradictions(items);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].keep).toBe("negation");
    expect(pairs[0].drop).toBe("affirm");
  });
});

describe("findContradictions — false-positive guards", () => {
  it("does not flag weakly-related rules across topics", () => {
    const items = [
      { text: "Use light mode by default.", payload: "light" },
      { text: "Never enable dark mode.", payload: "dark" },
    ];
    // Both touch "mode" but rest of the tokens diverge — one shared
    // content token / min(3, 3) = 0.33 < 0.4 threshold.
    const pairs = findContradictions(items);
    expect(pairs).toHaveLength(0);
  });

  it("does not flag two negations of the same thing", () => {
    const items = [
      { text: "Do not greet in Spanish", payload: "A" },
      { text: "Never use Spanish greetings", payload: "B" },
    ];
    const pairs = findContradictions(items);
    expect(pairs).toHaveLength(0); // same polarity
  });

  it("does not flag two affirmatives of the same thing", () => {
    const items = [
      { text: "Use English by default", payload: "A" },
      { text: "Always speak English", payload: "B" },
    ];
    const pairs = findContradictions(items);
    expect(pairs).toHaveLength(0); // same polarity
  });

  it("does not flag unrelated bullets", () => {
    const items = [
      { text: "Use English by default", payload: "lang" },
      { text: "Restart server after schema migration", payload: "ops" },
    ];
    const pairs = findContradictions(items);
    expect(pairs).toHaveLength(0);
  });
});

describe("findContradictions — greedy dedup", () => {
  it("each item appears in at most one pair", () => {
    const items = [
      { text: "Always greet in Spanish", payload: "spanish-affirm" },
      { text: "Never greet in Spanish", payload: "spanish-neg-1" },
      { text: "Do not greet in Spanish", payload: "spanish-neg-2" },
    ];
    const pairs = findContradictions(items);
    // First pair found drops the affirmative; second negation has no
    // affirmative left to pair with, so we get exactly one pair.
    expect(pairs).toHaveLength(1);
    expect(pairs[0].drop).toBe("spanish-affirm");
  });
});

describe("tokenizeStrict integration", () => {
  it("strips 'no' as a stopword — negation detection runs on raw text", () => {
    // Sanity check the dependency: our hasNegation can't rely on tokens.
    const tokens = tokenizeStrict("no Spanish greetings");
    expect(tokens.has("no")).toBe(false);
    expect(tokens.has("spanish")).toBe(true);
  });
});
