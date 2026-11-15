// jaccardSimilarity has one home, text-utils.ts; MMR and consolidation read
// it, so its edge cases are pinned here for every caller.
import { describe, expect, it } from "vitest";
import { jaccardSimilarity } from "./text-utils.js";

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
