/**
 * Regression test for CM-3: keyword-only hits in HYBRID mode could
 * mathematically never pass the injection threshold.
 *
 * In hybrid mode a chunk found only by FTS merged to textWeight(0.3)×score
 * (< 0.3), which can never reach the default minScore of 0.35 — so an exact
 * project-name match that missed the vector top-K was silently dropped as
 * "no relevant memories". The no-embedding branch relaxes the floor; the
 * hybrid branch didn't. Fix: keyword-only hits are rescored on their raw
 * FTS scale (missing from the vector top-K is absent evidence, not zero
 * relevance).
 */

import { describe, it, expect, vi } from "vitest";
import type Database from "better-sqlite3";
import { DEFAULT_MEMORY_CONFIG } from "../types.js";
import { searchInIndex } from "./search.js";
import type { SearchDeps } from "./types.js";

vi.mock("./keyword-search.js", () => ({
  searchKeyword: vi.fn(() => [
    {
      id: 1,
      path: "memory/bank/notes.md",
      source: "entity",
      startLine: 1,
      endLine: 4,
      text: "Bookwell project kickoff notes and goals",
      hash: "",
      score: 0.9, // strong exact keyword match
    },
  ]),
}));

vi.mock("./vector-search.js", () => ({
  searchVector: vi.fn(() => [
    {
      id: 2,
      path: "memory/bank/other.md",
      source: "entity",
      startLine: 1,
      endLine: 4,
      text: "vaguely related musings about reading habits",
      hash: "",
      score: 0.7, // decent semantic match, different chunk
    },
  ]),
}));

function makeDeps(): SearchDeps {
  return {
    // db is only touched by graph-boost traversal, which bails out for
    // queries without >=2 capitalized words — the query below is lowercase.
    db: {} as unknown as InstanceType<typeof Database>,
    embeddingProvider: {
      name: "stub",
      model: "stub",
      dimensions: 3,
      embed: async () => [0.1, 0.2, 0.3],
      embedBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
    },
    config: { ...DEFAULT_MEMORY_CONFIG },
    hasFts: true,
    sync: async () => {},
  };
}

describe("hybrid search: keyword-only hits vs minScore (CM-3)", () => {
  it("returns an exact FTS match that missed the vector top-K at the default minScore", async () => {
    const results = await searchInIndex(makeDeps(), "bookwell kickoff", {
      maxResults: 10,
      minScore: 0.35,
    });

    const kwHit = results.find((r) => r.snippet.includes("Bookwell"));
    // Pre-fix: merged score = 0.3 × 0.9 = 0.27 < 0.35 → dropped entirely.
    expect(kwHit, "keyword-only hit was filtered out in hybrid mode").toBeDefined();
    // Rescored on the raw FTS scale, not weight-crushed to 0.27.
    expect(kwHit!.score).toBeCloseTo(0.9, 5);
  });

  it("still weights chunks found by both modalities with the hybrid formula", async () => {
    const results = await searchInIndex(makeDeps(), "bookwell kickoff", {
      maxResults: 10,
      minScore: 0.35,
    });

    const vecHit = results.find((r) => r.snippet.includes("musings"));
    // Vector-only chunk keeps the existing behavior: vectorWeight × score.
    expect(vecHit).toBeDefined();
    expect(vecHit!.score).toBeCloseTo(0.7 * 0.7, 5);
  });
});
