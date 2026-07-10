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

import Database from "better-sqlite3";
import { afterEach, describe, it, expect, vi } from "vitest";
import { getAtlasRecords, getChunk } from "./index-atlas.js";
import { describeChunkProvenance, mergeHybridResults, toSearchResult } from "./search-helpers.js";
import type { Chunk, MemorySearchResult } from "./types.js";
import { memorySearchTool } from "./tools/search/memory-search.js";
import { searchPastSessionsTool } from "./tools/search/search-past-sessions.js";

vi.mock("./tools/search/app-matcher.js", () => ({ findMatchingApps: vi.fn(async () => []) }));

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

describe("memory provenance labels", () => {
  it("derives complete provenance for legacy chunks without stored labels", () => {
    const result = toSearchResult(chunk({
      source: "session",
      text: "prior turn",
      score: 0.8,
      metadata: {
        source_type: "agent-x-session",
        session_id: "session-123",
        date: "2026-07-09",
      },
    }), SNIPPET_MAX);

    expect(result.provenance).toEqual({
      source: "session",
      source_type: "agent-x-session",
      session_id: "session-123",
      date: "2026-07-09",
      trust_status: "mixed",
      taint_status: "unknown",
      label: "Local session transcript",
    });
    expect(result.metadata).toMatchObject({
      trust_status: "mixed",
      taint_status: "unknown",
      provenance_label: "Local session transcript",
    });
  });

  it("preserves explicitly recorded trust, taint, and label values", () => {
    const provenance = describeChunkProvenance("import", {
      source_type: "import",
      trust_status: "trusted",
      taint_status: "clean",
      provenance_label: "Reviewed archive",
    });

    expect(provenance.trust_status).toBe("trusted");
    expect(provenance.taint_status).toBe("clean");
    expect(provenance.label).toBe("Reviewed archive");
  });
});

describe("retrieval provenance output", () => {
  const result: MemorySearchResult = {
    path: "session-live/session-123",
    startLine: 1,
    endLine: 2,
    score: 0.87,
    snippet: "A prior conversation snippet.",
    source: "session",
    metadata: {
      source_type: "agent-x-session",
      session_id: "session-123456789",
      date: "2026-07-09",
    },
    provenance: {
      source: "session",
      source_type: "agent-x-session",
      session_id: "session-123456789",
      date: "2026-07-09",
      trust_status: "mixed",
      taint_status: "unknown",
      label: "Local session transcript",
    },
  };

  function stubMemory() {
    return {
      memoryDir: "C:\\memory",
      search: vi.fn(async () => [result]),
    } as never;
  }

  it("includes provenance in memory_search and explicit past-session results", async () => {
    const regular = await memorySearchTool(stubMemory()).execute({ query: "prior" });
    const past = await searchPastSessionsTool(stubMemory()).execute({ query: "prior" });

    for (const content of [regular.content, past.content]) {
      expect(content).toContain("source=session");
      expect(content).toContain("source_type=agent-x-session");
      expect(content).toContain("date=2026-07-09");
      expect(content).toContain("trust=mixed");
      expect(content).toContain("taint=unknown");
      expect(content).toContain('label="Local session transcript"');
    }
    expect(regular.content).toContain("session=session-123456789");
    expect(past.content).toContain("session=session-123");
  });
});

describe("atlas provenance", () => {
  let db: InstanceType<typeof Database> | undefined;

  afterEach(() => db?.close());

  it("returns complete labels for stored metadata and legacy rows", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        metadata TEXT,
        path TEXT NOT NULL,
        embedding BLOB,
        updated_at INTEGER NOT NULL
      )
    `);
    db.prepare(
      "INSERT INTO chunks (id, text, source, metadata, path, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      1,
      "Session memory",
      "session",
      JSON.stringify({ source_type: "agent-x-session", session_id: "sess-1", date: "2026-07-09" }),
      "session-live/sess-1",
      Buffer.from([1]),
      2,
    );

    const record = getAtlasRecords(db, 10).items[0];
    expect(record).toMatchObject({
      source: "session",
      sourceType: "agent-x-session",
      sessionId: "sess-1",
      date: "2026-07-09",
      trustStatus: "mixed",
      taintStatus: "unknown",
      label: "Local session transcript",
    });
    expect(getChunk(db, 1)).toMatchObject({
      text: "Session memory",
      sourceType: record.sourceType,
      sessionId: record.sessionId,
      trustStatus: record.trustStatus,
      taintStatus: record.taintStatus,
      label: record.label,
    });
  });
});
