// jaccardSimilarity has one home, text-utils.ts; MMR and consolidation read
// it, so its edge cases are pinned here for every caller.
import { describe, expect, it } from "vitest";
import { jaccardSimilarity, tokenizeStrict } from "./text-utils.js";

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

describe("tokenizeStrict", () => {
  const words = (text: string) => [...tokenizeStrict(text)];

  it("keeps an English sentence's content words, dropping stopwords and short words", () => {
    expect(words("The user's cousin keeps it at slip 14 in Port-Avila")).toEqual(["user", "cousin", "keeps", "slip", "port", "avila"]);
  });

  it("keeps words in every script, not only ASCII", () => {
    expect(words("Одалис живёт в Лиссабоне")).toEqual(["одалис", "живёт", "лиссабоне"]);
    expect(words("Le café près d'Évora")).toEqual(["café", "près", "évora"]);
  });

  it("keeps a two-character word in a syllabic script", () => {
    expect(words("서울 에 살아요")).toEqual(["서울", "에", "살아요"]);
    expect(words("東京")).toEqual(["東京"]);
  });
});
