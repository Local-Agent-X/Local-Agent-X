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
import { searchKeyword } from "./keyword-search.js";
import { searchVector } from "./vector-search.js";

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
    // Rescored off the weight-crushed 0.27 and lifted above the floor, but
    // capped at vectorWeight (0.7) so a keyword-only hit can't outrank the
    // ceiling of a vector-only hit (vectorWeight×score).
    expect(kwHit!.score).toBeCloseTo(0.7, 5);
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

describe("hybrid search: keyword-only vs vector-found siblings sharing startLine (CM-3/CM-4)", () => {
  it("rescues a keyword-only split part that shares path AND startLine with a vector-found sibling", async () => {
    // chunkConversationPairs stamps every split part of one long answer with
    // the SAME startLine. Here the vector channel found the EARLIER part and
    // the keyword channel found a LATER part of the SAME conversation — same
    // path, same startLine, DIFFERENT chunk ids.
    vi.mocked(searchVector).mockReturnValueOnce([
      {
        id: 10,
        path: "sessions/imported-convo.jsonl",
        source: "import",
        startLine: 5,
        endLine: 5,
        text: "[assistant] earlier part of the answer, semantically related",
        hash: "",
        score: 0.7,
      },
    ]);
    vi.mocked(searchKeyword).mockReturnValueOnce([
      {
        id: 11,
        path: "sessions/imported-convo.jsonl", // SAME path
        source: "import",
        startLine: 5, // SAME startLine — the positional-key collision
        endLine: 5,
        text: "[assistant] later part naming the Bookwell project exactly",
        hash: "",
        score: 0.9, // strong exact keyword match
      },
    ]);

    const results = await searchInIndex(makeDeps(), "bookwell", {
      maxResults: 10,
      minScore: 0.35,
    });

    // Pre-fix: vectorKeys keyed on `path:startLine`, so the keyword-only later
    // part's key ("sessions/imported-convo.jsonl:5") already lived in the set
    // from its vector-found sibling → misclassified as vector-found → denied
    // the rescore → stuck at 0.3×0.9 = 0.27 < 0.35 → dropped entirely.
    const kwHit = results.find((r) => r.snippet.includes("later part"));
    expect(
      kwHit,
      "keyword-only later part sharing a startLine with a vector sibling was dropped"
    ).toBeDefined();
    // Rescored on identity (id 11 ∉ {10}) and lifted above the floor, capped
    // at vectorWeight.
    expect(kwHit!.score).toBeCloseTo(0.7, 5);

    // The vector-found earlier part is unaffected: vectorWeight × score.
    const vecHit = results.find((r) => r.snippet.includes("earlier part"));
    expect(vecHit).toBeDefined();
    expect(vecHit!.score).toBeCloseTo(0.7 * 0.7, 5);
  });
});
