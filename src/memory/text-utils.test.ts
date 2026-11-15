// jaccardSimilarity has one home, text-utils.ts; the memory search's MMR rerank
// reads it too, so its edge cases are pinned here for every caller.
import { describe, expect, it } from "vitest";
import { mmrRerank } from "./search-helpers.js";
import { jaccardSimilarity } from "./text-utils.js";
import type { MemorySearchResult } from "./types.js";

describe("jaccardSimilarity", () => {
  it("is intersection over union, for sets and plain iterables alike", () => {
    expect(jaccardSimilarity(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBe(0.5);
    expect(jaccardSimilarity(["a", "b", "b"], ["b", "a"])).toBe(1);
  });

  it("calls two empty inputs identical and one empty input disjoint", () => {
    expect(jaccardSimilarity([], [])).toBe(1);
    expect(jaccardSimilarity(["a"], [])).toBe(0);
    expect(jaccardSimilarity([], new Set(["a"]))).toBe(0);
  });
});

describe("mmrRerank (search-helpers)", () => {
  const hit = (snippet: string, score: number): MemorySearchResult =>
    ({ path: `${snippet}.md`, startLine: 1, endLine: 1, score, snippet, source: "daily-log" });

  it("ranks a different hit above a near duplicate of the top one", () => {
    const top = hit("peter moved the shop to mckinney in june", 1);
    const dupe = hit("peter moved the shop to mckinney in june 2026", 0.95);
    const other = hit("the kraken bot trades eth on weekends", 0.9);
    expect(mmrRerank([top, dupe, other], 3, 0.5).map((r) => r.snippet)).toEqual([top.snippet, other.snippet, dupe.snippet]);
  });
});
