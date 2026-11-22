// The atlas labels a cluster with the words that are frequent in it and rare
// elsewhere. Its terms are memory's content words (text-utils.ts); the atlas
// keeps only the words that are noise in this corpus and nowhere else.
import { describe, expect, it } from "vitest";
import { labelClusters } from "./atlas-math.js";
import { contentWords } from "./text-utils.js";

function bucket(texts: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of texts) for (const term of contentWords(t)) counts.set(term, (counts.get(term) || 0) + 1);
  return counts;
}

describe("labelClusters over memory's content words", () => {
  it("labels each cluster by its own words, never by the corpus's structural ones", () => {
    const labels = labelClusters([
      bucket(["user: one new sourdough starter", "assistant: feed the sourdough starter"]),
      bucket(["user: two new kelp forests", "assistant: kelp forests shelter otters"]),
    ], 2);
    expect(labels).toEqual(["sourdough · starter", "kelp · forests"]);
  });

  it("labels a cluster of memories in another script", () => {
    const labels = labelClusters([
      bucket(["Одалис живёт в Лиссабоне", "Одалис любит Лиссабон"]),
      bucket(["the sourdough starter"]),
    ], 1);
    expect(labels[0]).toBe("одалис");
  });
});
