/**
 * Regression tests for the off-thread vector scan (C4).
 *
 * The synchronous full-corpus cosine scan blocked the Node event loop for
 * 13-21s on a 45k-chunk corpus, freezing the whole server (and tripping the
 * 10s buildTurnContextCached backstop into shipping memory-less turns).
 * searchVectorOffThread runs the identical scan in a worker_thread.
 *
 * 1. PARITY — the worker path returns exactly what the pre-change
 *    synchronous scan returned (same ids, same order, scores within 1e-6),
 *    across source and session filter variants. referenceScan below is a
 *    verbatim copy of the old LIMIT/OFFSET implementation.
 * 2. FALLBACK — in-memory databases (invisible to a second connection) fall
 *    back to the in-process scan and still return full results.
 * 3. LOOP LIBERATION — a setImmediate drift probe during a search over
 *    thousands of chunks stays under a generous gap threshold. On the old
 *    synchronous code the gap equals the whole scan duration, so this test
 *    fails if the scan ever moves back onto the main loop.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import type { Chunk } from "../types.js";
import { cosineSimilarity } from "../utils.js";
import { searchVector, searchVectorOffThread } from "./vector-search.js";

const tempDir = mkdtempSync(join(tmpdir(), "lax-vector-search-"));
afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

// Deterministic PRNG so parity comparisons are reproducible.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const SCHEMA = `
  CREATE TABLE chunks (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL,
    source TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    text TEXT NOT NULL,
    embedding TEXT,
    metadata TEXT,
    session_id TEXT,
    updated_at INTEGER NOT NULL
  );
`;

function seedCorpus(
  db: InstanceType<typeof Database>,
  count: number,
  dims: number,
  seed: number
): void {
  db.exec(SCHEMA);
  const rand = lcg(seed);
  const insert = db.prepare(
    "INSERT INTO chunks (path, source, start_line, end_line, text, embedding, metadata, session_id, updated_at) VALUES (?, ?, 1, 1, ?, ?, ?, ?, 1)"
  );
  const sources = ["entity", "session", "session", "import"] as const;
  const sessionIds = [null, "current", "other", "archive"] as const;
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const embedding =
        i % 97 === 0
          ? "not-json{" // corrupt rows must be skipped identically on both paths
          : JSON.stringify(Array.from({ length: dims }, () => rand() * 2 - 1));
      insert.run(
        `memory/bank/${i}.md`,
        sources[i % sources.length],
        `chunk ${i} text`,
        i % 53 === 0 ? null : embedding, // some rows have no embedding at all
        i % 2 === 0 ? JSON.stringify({ date: "2026-07-14" }) : null,
        sessionIds[i % sessionIds.length]
      );
    }
  })();
}

function queryVecFor(dims: number, seed: number): number[] {
  const rand = lcg(seed);
  return Array.from({ length: dims }, () => rand() * 2 - 1);
}

/**
 * Verbatim copy of the pre-change synchronous scan (COUNT + LIMIT/OFFSET
 * batches). This is the behavioral reference the worker path must match.
 */
function referenceScan(
  db: InstanceType<typeof Database>,
  queryVec: number[],
  limit: number,
  sources?: string[],
  sessionFilter?: string | null
): Array<Chunk & { score: number }> {
  const BATCH_SIZE = 1000;
  const sourceFilter = sources ? `AND source IN (${sources.map(() => "?").join(",")})` : "";
  const sessionWhere = sessionFilter !== undefined
    ? `AND (source IN ('entity', 'mind', 'personality', 'import')${sessionFilter ? " OR session_id = ?" : ""})`
    : "";
  const baseParams: unknown[] = sources ? [...sources] : [];
  const params = sessionFilter ? [...baseParams, sessionFilter] : baseParams;

  const totalCount = (
    db
      .prepare(`SELECT COUNT(*) as n FROM chunks WHERE embedding IS NOT NULL ${sourceFilter} ${sessionWhere}`)
      .get(...params) as { n: number }
  ).n;

  const results: Array<Chunk & { score: number }> = [];
  let minResultScore = -Infinity;

  for (let offset = 0; offset < totalCount; offset += BATCH_SIZE) {
    const batch = db
      .prepare(
        `SELECT id, path, source, start_line, end_line, text, embedding, metadata, session_id, updated_at
         FROM chunks WHERE embedding IS NOT NULL ${sourceFilter} ${sessionWhere}
         LIMIT ? OFFSET ?`
      )
      .all(...params, BATCH_SIZE, offset) as Array<{
      id: number;
      path: string;
      source: string;
      start_line: number;
      end_line: number;
      text: string;
      embedding: string;
      metadata: string | null;
      session_id: string | null;
      updated_at: number;
    }>;

    for (const row of batch) {
      let embedding: number[];
      try {
        embedding = JSON.parse(row.embedding);
      } catch {
        continue;
      }
      const similarity = cosineSimilarity(queryVec, embedding);
      if (!Number.isFinite(similarity)) continue;
      if (results.length < limit * 2 || similarity > minResultScore) {
        results.push({
          id: row.id,
          path: row.path,
          source: row.source,
          startLine: row.start_line,
          endLine: row.end_line,
          text: row.text,
          hash: "",
          metadata: {
            ...(row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : {}),
            session_id: row.session_id ?? undefined,
          },
          updatedAt: row.updated_at,
          score: similarity,
        });
        if (results.length > limit * 4) {
          results.sort((a, b) => b.score - a.score);
          results.length = limit * 2;
          minResultScore = results[results.length - 1].score;
        }
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

describe("searchVectorOffThread parity with the synchronous scan", () => {
  const DIMS = 32;
  const dbPath = join(tempDir, "parity.db");
  const db = new Database(dbPath);
  seedCorpus(db, 400, DIMS, 42);
  afterAll(() => db.close());

  const filterVariants: Array<{
    name: string;
    sources?: string[];
    sessionFilter?: string | null;
  }> = [
    { name: "unfiltered" },
    { name: "session-scoped", sessionFilter: "current" },
    { name: "no-session (profile only)", sessionFilter: null },
    { name: "source-filtered", sources: ["entity", "import"] },
    { name: "source + session", sources: ["session"], sessionFilter: "current" },
  ];

  for (const variant of filterVariants) {
    it(`matches ids, order, and scores (${variant.name})`, async () => {
      const queryVec = queryVecFor(DIMS, 7);
      const expected = referenceScan(db, queryVec, 25, variant.sources, variant.sessionFilter);
      const actual = await searchVectorOffThread(db, queryVec, 25, variant.sources, variant.sessionFilter);

      expect(expected.length).toBeGreaterThan(0); // a vacuous corpus proves nothing
      expect(actual.map((r) => r.id)).toEqual(expected.map((r) => r.id));
      for (let i = 0; i < expected.length; i++) {
        expect(Math.abs(actual[i].score - expected[i].score)).toBeLessThan(1e-6);
        expect(actual[i].metadata).toEqual(expected[i].metadata);
      }
    });
  }
});

describe("searchVectorOffThread in-memory fallback", () => {
  it("returns full in-process results for a db a second connection cannot see", async () => {
    const db = new Database(":memory:");
    try {
      seedCorpus(db, 120, 16, 5);
      const queryVec = queryVecFor(16, 3);
      const expected = searchVector(db, queryVec, 10);
      const actual = await searchVectorOffThread(db, queryVec, 10);
      expect(expected.length).toBeGreaterThan(0);
      expect(actual).toEqual(expected);
    } finally {
      db.close();
    }
  });
});

describe("event-loop liberation during vector search", () => {
  it("keeps setImmediate drift small while scanning thousands of chunks", async () => {
    const DIMS = 384;
    const dbPath = join(tempDir, "liberation.db");
    const db = new Database(dbPath);
    try {
      seedCorpus(db, 15000, DIMS, 99);
      const queryVec = queryVecFor(DIMS, 11);

      // Baseline: how long the synchronous scan monopolizes the loop here.
      const t0 = Date.now();
      const syncResults = referenceScan(db, queryVec, 50);
      const syncMs = Date.now() - t0;
      expect(syncResults.length).toBeGreaterThan(0);
      // Validity guard: if the corpus scans faster than this, the probe below
      // proves nothing — enlarge the corpus instead of trusting a green run.
      expect(syncMs, "sync scan too fast to make the drift probe meaningful").toBeGreaterThan(250);

      // Drift probe: on the old code the largest gap equals the whole scan.
      let maxGapMs = 0;
      let probing = true;
      let last = Date.now();
      const tick = () => {
        if (!probing) return;
        const now = Date.now();
        if (now - last > maxGapMs) maxGapMs = now - last;
        last = now;
        setImmediate(tick);
      };
      setImmediate(tick);

      const asyncResults = await searchVectorOffThread(db, queryVec, 50);
      // The await continuation is a MICROtask — it runs before any pending
      // setImmediate tick, so a fully synchronous scan would stop the probe
      // with maxGapMs still 0. Capture the gap since the last tick explicitly.
      const tailGap = Date.now() - last;
      if (tailGap > maxGapMs) maxGapMs = tailGap;
      probing = false;

      expect(asyncResults.map((r) => r.id)).toEqual(syncResults.map((r) => r.id));
      // Generous, machine-adaptive threshold: comfortably above worker spawn
      // jitter in CI, but always below the synchronous scan's full-block gap
      // (max(200, syncMs/2) < syncMs whenever syncMs > 400ms — and the old
      // code blocked for the ENTIRE syncMs).
      expect(maxGapMs).toBeLessThan(Math.max(200, syncMs / 2));
    } finally {
      db.close();
    }
  });
});
