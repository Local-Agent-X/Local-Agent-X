/**
 * Provider-signature reconciliation: vectors written by one embedding
 * provider must never be cosine-compared against another provider's query
 * vectors. A provider/model/dims change wipes stale vectors and the
 * background pass rebuilds them; the silent no-API-key fallback to `local`
 * must NOT wipe (a transient key failure would otherwise force a full paid
 * re-embed on every flap).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "./index.js";
import {
  reconcileEmbeddingSignature,
  reembedMissingChunks,
  countChunksMissingEmbedding,
  nullDimensionMismatchedEmbeddings,
} from "./index-embedding.js";
import { DEFAULT_MEMORY_CONFIG, type EmbeddingProvider } from "./types.js";

function fakeProvider(name: string, model: string, dims: number): EmbeddingProvider {
  const vec = () => Array.from({ length: dims }, (_, i) => (i + 1) / dims);
  return {
    name, model, dimensions: dims,
    embed: async () => vec(),
    embedBatch: async (texts: string[]) => texts.map(() => vec()),
  };
}

let tempDir: string;
let memory: MemoryIndex;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-embed-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  memory = new MemoryIndex(tempDir);
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

function insertChunk(text: string, embedding: number[] | null): number {
  const db = memory["db"];
  const r = db.prepare(`
    INSERT INTO chunks (path, source, start_line, end_line, text, hash, content_hash, embedding, updated_at)
    VALUES ('t.md', 'personality', 1, 1, ?, ?, ?, ?, ?)
  `).run(text, `h-${text}`, `h-${text}`, embedding ? JSON.stringify(embedding) : null, Date.now());
  return Number(r.lastInsertRowid);
}

function embeddingOf(chunkId: number): number[] | null {
  const db = memory["db"];
  const row = db.prepare("SELECT embedding FROM chunks WHERE id = ?").get(chunkId) as { embedding: string | null };
  return row.embedding ? JSON.parse(row.embedding) : null;
}

describe("reconcileEmbeddingSignature", () => {
  it("adopts on an empty index, then matches on the same provider", async () => {
    const db = memory["db"];
    const prov = fakeProvider("fake", "m1", 4);
    expect(await reconcileEmbeddingSignature(db, prov)).toBe("adopted");
    expect(await reconcileEmbeddingSignature(db, prov)).toBe("match");
  });

  it("wipes stale vectors on a provider change", async () => {
    const db = memory["db"];
    const provA = fakeProvider("fake", "m1", 4);
    await reconcileEmbeddingSignature(db, provA);
    const id = insertChunk("hello world", [0.1, 0.2, 0.3, 0.4]);

    const provB = fakeProvider("fake", "m2", 8);
    expect(await reconcileEmbeddingSignature(db, provB)).toBe("wiped");
    expect(embeddingOf(id)).toBeNull();
    // Signature now pins the new provider — no second wipe.
    expect(await reconcileEmbeddingSignature(db, provB)).toBe("match");
  });

  it("claims pre-signature vectors when the cache corroborates the provider", async () => {
    const db = memory["db"];
    const prov = fakeProvider("fake", "m1", 4);
    insertChunk("hello", [0.1, 0.2, 0.3, 0.4]);
    db.prepare(
      "INSERT INTO embedding_cache (hash, provider, model, embedding, updated_at) VALUES ('h-hello', 'fake', 'm1', '[0.1,0.2,0.3,0.4]', ?)"
    ).run(Date.now());

    expect(await reconcileEmbeddingSignature(db, prov)).toBe("adopted");
    expect(countChunksMissingEmbedding(db)).toBe(0);
  });

  it("wipes pre-signature vectors when nothing ties them to the current provider", async () => {
    const db = memory["db"];
    const id = insertChunk("hello", [0.1, 0.2, 0.3, 0.4]);
    const prov = fakeProvider("fake", "m1", 4);

    expect(await reconcileEmbeddingSignature(db, prov)).toBe("wiped");
    expect(embeddingOf(id)).toBeNull();
  });

  it("does NOT wipe when falling back to local — degraded, vectors intact", async () => {
    const db = memory["db"];
    const real = fakeProvider("ollama", "mxbai", 4);
    await reconcileEmbeddingSignature(db, real);
    const id = insertChunk("hello", [0.1, 0.2, 0.3, 0.4]);

    const local = fakeProvider("local", "tfidf", 16);
    expect(await reconcileEmbeddingSignature(db, local)).toBe("degraded");
    expect(embeddingOf(id)).toEqual([0.1, 0.2, 0.3, 0.4]);
    // The real provider coming back is a plain match — still no wipe.
    expect(await reconcileEmbeddingSignature(db, real)).toBe("match");
    expect(embeddingOf(id)).toEqual([0.1, 0.2, 0.3, 0.4]);
  });
});

// Regression (live 2026-06-12): a saved instruction in 2026-04-07.md was
// unfindable by memory_search because its chunk kept a stale-DIMENSION vector
// from an earlier embedding model — vector search silently scores mismatched
// dimensions 0, so the content was on disk but invisible. The app must SELF-HEAL
// this without a human running memory_reindex.
describe("nullDimensionMismatchedEmbeddings (self-heal)", () => {
  it("nulls stale-dimension vectors and leaves correct-dimension ones intact", async () => {
    const db = memory["db"];
    const prov = fakeProvider("fake", "m1", 4);
    await reconcileEmbeddingSignature(db, prov);
    const right = insertChunk("right dims", [1, 2, 3, 4]);                 // dim 4 — matches provider
    const stale = insertChunk("orphaned by a model change", [1, 2, 3, 4, 5, 6, 7, 8]); // dim 8 — mismatch

    expect(await nullDimensionMismatchedEmbeddings(db, prov)).toBe(1);
    expect(embeddingOf(right)).toEqual([1, 2, 3, 4]);
    expect(embeddingOf(stale)).toBeNull(); // healed → will be re-embedded
  });

  it("PROVES the heal: an orphaned chunk is re-embedded under the current provider and becomes searchable", async () => {
    const db = memory["db"];
    const current = fakeProvider("ollama", "mxbai", 8);
    await reconcileEmbeddingSignature(db, current); // current vector space is 8-dim

    // A chunk left behind with an OLD provider's 4-dim vector (the orphan bug):
    // its text is on disk + indexed, but at dim 4 it's invisible to 8-dim search.
    const orphan = insertChunk("peter would never kill himself", [0.1, 0.2, 0.3, 0.4]);
    expect(embeddingOf(orphan)).toHaveLength(4);

    // Self-heal: NULL the dimension-mismatched vector, then the standard backfill
    // rebuilds it under the current provider.
    expect(await nullDimensionMismatchedEmbeddings(db, current)).toBe(1);
    expect(embeddingOf(orphan)).toBeNull();
    await reembedMissingChunks(db, current, DEFAULT_MEMORY_CONFIG, false);

    // Now embedded at the correct dimension — findable again. No human reindex.
    expect(embeddingOf(orphan)).toHaveLength(8);
    expect(countChunksMissingEmbedding(db)).toBe(0);
  });
});

describe("reembedMissingChunks", () => {
  it("fills every NULL embedding and leaves existing ones alone", async () => {
    const db = memory["db"];
    const prov = fakeProvider("fake", "m1", 4);
    await reconcileEmbeddingSignature(db, prov);

    const existing = insertChunk("already embedded", [9, 9, 9, 9]);
    const missing1 = insertChunk("needs a vector", null);
    const missing2 = insertChunk("also needs a vector", null);

    const r = await reembedMissingChunks(db, prov, DEFAULT_MEMORY_CONFIG, false);
    expect(r.embedded).toBe(2);
    expect(r.missing).toBe(0);
    expect(embeddingOf(existing)).toEqual([9, 9, 9, 9]);
    expect(embeddingOf(missing1)).toHaveLength(4);
    expect(embeddingOf(missing2)).toHaveLength(4);
    expect(countChunksMissingEmbedding(db)).toBe(0);
  });

  it("stops without spinning when the provider is down, and resumes later", async () => {
    const db = memory["db"];
    const dead: EmbeddingProvider = {
      name: "fake", model: "m1", dimensions: 4,
      embed: async () => { throw new Error("down"); },
      embedBatch: async () => { throw new Error("down"); },
    };
    insertChunk("stranded chunk", null);

    const cfg = { ...DEFAULT_MEMORY_CONFIG, retryMaxAttempts: 1, retryBaseDelayMs: 1 };
    const r1 = await reembedMissingChunks(db, dead, cfg, false);
    expect(r1.embedded).toBe(0);
    expect(r1.missing).toBe(1);

    const r2 = await reembedMissingChunks(db, fakeProvider("fake", "m1", 4), cfg, false);
    expect(r2.embedded).toBe(1);
    expect(countChunksMissingEmbedding(db)).toBe(0);
  });
});

// Regression (boot starvation, measured 2026-07): the provider-change wipe ran
// as ONE synchronous full-table UPDATE over ~45k chunks on the main event loop,
// stalling every concurrent awaited boot phase (setupVoiceWs inflated 17-21s).
// The wipe must batch its sqlite work and yield between batches so concurrent
// work keeps progressing.
describe("event-loop yielding during heavy sqlite work", () => {
  it("provider-change wipe over thousands of chunks yields the event loop", async () => {
    const db = memory["db"];
    const provA = fakeProvider("fake", "m1", 8);
    await reconcileEmbeddingSignature(db, provA);

    const ROWS = 12_000; // > 2 batch windows at any 2000-5000 batch size; CI-safe
    const vec = JSON.stringify(Array.from({ length: 8 }, (_, i) => i / 8));
    const ins = db.prepare(`
      INSERT INTO chunks (path, source, start_line, end_line, text, hash, content_hash, embedding, updated_at)
      VALUES ('t.md', 'personality', 1, 1, ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
      for (let i = 0; i < ROWS; i++) ins.run(`c${i}`, `h${i}`, `h${i}`, vec, Date.now());
    })();

    // Event-loop probe: counts turns and tracks the longest gap between them.
    // A synchronous full-table wipe gives the probe ZERO turns until it ends.
    let turns = 0;
    let maxGapMs = 0;
    let last = Date.now();
    let stop = false;
    const probe = (async () => {
      while (!stop) {
        await new Promise<void>((r) => setImmediate(r));
        const now = Date.now();
        if (now - last > maxGapMs) maxGapMs = now - last;
        last = now;
        turns++;
      }
    })();

    last = Date.now();
    const verdict = await reconcileEmbeddingSignature(db, fakeProvider("fake", "m2", 8));
    stop = true;
    await probe;

    expect(verdict).toBe("wiped");
    expect(countChunksMissingEmbedding(db)).toBe(ROWS); // same end state as before
    // Deterministic starvation check: the wipe must hand the loop back at
    // least twice mid-flight (12k rows / <=5k batch => >=2 interior yields).
    expect(turns).toBeGreaterThanOrEqual(2);
    // And no single stall may approach the observed multi-second starvation.
    expect(maxGapMs).toBeLessThan(250);
  });
});
