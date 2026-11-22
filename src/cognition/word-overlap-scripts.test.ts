// Cognition's word checks read memory's split rule (memory/text-utils.ts).
// Each had an ASCII-only one of its own, so for a user who writes in another
// script a contradiction never overlapped, a narrative never matched its
// query, and a correction had no topic.
import { describe, expect, it } from "vitest";
import { keywordOverlap } from "./contradiction-patterns.js";
import { scoreMatch } from "./narrative-memory-store.js";
import { correctionTopics } from "./correction-learning-detect.js";

describe("keywordOverlap", () => {
  it("is the share of the smaller text's words the other one has", () => {
    expect(keywordOverlap("I moved to Denver this year", "I moved to Boston this year")).toBe(0.75);
    expect(keywordOverlap("kelp forests", "sourdough starter")).toBe(0);
  });

  it("counts words in any script", () => {
    expect(keywordOverlap("Одалис живёт в Лиссабоне", "Одалис живёт в Порту")).toBeCloseTo(2 / 3);
    expect(keywordOverlap("Одалис живёт в Лиссабоне", "")).toBe(0);
  });
});

describe("scoreMatch", () => {
  it("is the share of the query's words the text contains", () => {
    expect(scoreMatch("We moved to Lisbon last spring", "lisbon move")).toBe(1);
    expect(scoreMatch("We moved to Lisbon last spring", "lisbon winter")).toBe(0.5);
  });

  it("matches a query in any script", () => {
    expect(scoreMatch("Одалис переехала в Лиссабон", "Лиссабон")).toBe(1);
    expect(scoreMatch("Одалис переехала в Лиссабон", "")).toBe(0);
  });
});

describe("correctionTopics", () => {
  it("is the capitalized words and quoted strings of a correction", () => {
    expect(correctionTopics('the store is in McKinney, not "plano texas"')).toEqual(["mckinney", "plano texas"]);
  });

  it("keeps a capitalized name in any script", () => {
    expect(correctionTopics("она живёт в Лиссабоне, а не в Порту")).toEqual(["лиссабоне", "порту"]);
  });
});
