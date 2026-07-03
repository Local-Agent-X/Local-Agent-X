/**
 * mergeHybridResults regression tests (CM-4).
 *
 * Focus: the hybrid dedup key must identify a CHUNK, not a path:startLine
 * position. chunkConversationPairs assigns the same startLine to every split
 * part of a long answer, so keying on position merged distinct chunks found
 * by different channels — summing unrelated scores and making later parts
 * unreachable. The key must be the chunk id (positional+hash fallback only
 * when no id exists).
 */

import { describe, it, expect } from "vitest";
import { mergeHybridResults } from "./search-helpers.js";
import type { Chunk } from "./types.js";

const SNIPPET_MAX = 500;

function chunk(over: Partial<Chunk> & { score: number }): Chunk & { score: number } {
  return {
    path: "sessions/abc.jsonl",
    source: "session",
    startLine: 3,
    endLine: 3,
    text: "placeholder",
    hash: "",
    ...over,
  };
}

describe("mergeHybridResults chunk identity (CM-4)", () => {
  it("keeps distinct chunks that share path:startLine as separate results", () => {
    // Two split parts of one long answer — same path + startLine, different ids.
    const part1 = chunk({ id: 101, text: "[user] q\n\n[assistant] part one", score: 0.9 });
    const part2 = chunk({ id: 102, text: "[user] q\n\n[assistant] part two", score: 0.8 });

    // Vector channel found part1; keyword channel found part2.
    const results = mergeHybridResults([part2], [part1], 0.5, 0.5, SNIPPET_MAX);

    expect(results).toHaveLength(2);
    const snippets = results.map((r) => r.snippet).sort();
    expect(snippets).toEqual([
      "[user] q\n\n[assistant] part one",
      "[user] q\n\n[assistant] part two",
    ]);
    // Scores stay per-chunk: single-channel hits, weighted by their channel only.
    expect(results.find((r) => r.snippet.includes("part one"))!.score).toBeCloseTo(0.45);
    expect(results.find((r) => r.snippet.includes("part two"))!.score).toBeCloseTo(0.4);
  });

  it("still merges the SAME chunk found by both channels into one weighted result", () => {
    const viaVector = chunk({ id: 101, text: "same chunk", score: 0.8 });
    const viaKeyword = chunk({ id: 101, text: "same chunk", score: 0.6 });

    const results = mergeHybridResults([viaKeyword], [viaVector], 0.7, 0.3, SNIPPET_MAX);

    expect(results).toHaveLength(1);
    expect(results[0].score).toBeCloseTo(0.7 * 0.8 + 0.3 * 0.6);
  });

  it("falls back to path:startLine:hash identity when chunks carry no id", () => {
    const a = chunk({ text: "chunk a", hash: "hash-a", score: 0.9 });
    const b = chunk({ text: "chunk b", hash: "hash-b", score: 0.7 });
    const aAgain = chunk({ text: "chunk a", hash: "hash-a", score: 0.5 });

    const results = mergeHybridResults([b, aAgain], [a], 0.5, 0.5, SNIPPET_MAX);

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.snippet === "chunk a")!.score).toBeCloseTo(0.5 * 0.9 + 0.5 * 0.5);
    expect(results.find((r) => r.snippet === "chunk b")!.score).toBeCloseTo(0.35);
  });
});
