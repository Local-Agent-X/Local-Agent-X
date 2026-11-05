// mergeRelatedFacts groups near-identical facts. Its words are split once per fact and
// pairs of very different size are skipped unread; both must leave the groups exactly
// what comparing every pair's text gives.
import { describe, expect, it } from "vitest";
import { mergeRelatedFacts } from "./analyze.js";
import { jaccardSimilarity } from "./utils.js";
import type { FactEntry } from "./types.js";

const fact = (content: string): FactEntry => ({ content, confidence: 0.5, accessCount: 1, createdAt: 0 });

/** The grouping as written before: every pair's text compared in full. */
function groupsByFullComparison(facts: FactEntry[], min: number): string[][] {
  const used = new Set<number>();
  const groups: string[][] = [];
  for (let i = 0; i < facts.length; i++) {
    if (used.has(i)) continue;
    const group = [facts[i]!.content];
    used.add(i);
    for (let j = i + 1; j < facts.length; j++) {
      if (!used.has(j) && jaccardSimilarity(facts[i]!.content, facts[j]!.content) >= min) {
        group.push(facts[j]!.content);
        used.add(j);
      }
    }
    if (group.length > 1) groups.push(group);
  }
  return groups;
}

describe("mergeRelatedFacts", () => {
  it("groups facts that say the same thing and keeps the most detailed one", () => {
    const merged = mergeRelatedFacts([
      fact("Peter runs NutriShop in McKinney Texas"),
      fact("Peter runs NutriShop in McKinney Texas store"),
      fact("The voice sidecar listens on port 7008"),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.merged).toBe("Peter runs NutriShop in McKinney Texas store");
  });

  it("matches comparing every pair in full, on facts of mixed sizes", () => {
    const vocab = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const facts = Array.from({ length: 120 }, () => {
      const n = 1 + Math.floor(rand() * 8);
      return fact(Array.from({ length: n }, () => vocab[Math.floor(rand() * vocab.length)]).join(" "));
    });
    facts.push(fact(""), fact("a an"));
    const groups = mergeRelatedFacts(facts).map((m) => m.original.map((f) => f.content));
    expect(groups.length).toBeGreaterThan(0);
    expect(groups).toEqual(groupsByFullComparison(facts, 0.7));
  });
});
