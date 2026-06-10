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
  it("adopts on an empty index, then matches on the same provider", () => {
    const db = memory["db"];
    const prov = fakeProvider("fake", "m1", 4);
    expect(reconcileEmbeddingSignature(db, prov)).toBe("adopted");
    expect(reconcileEmbeddingSignature(db, prov)).toBe("match");
  });

  it("wipes stale vectors on a provider change", () => {
    const db = memory["db"];
    const provA = fakeProvider("fake", "m1", 4);
    reconcileEmbeddingSignature(db, provA);
    const id = insertChunk("hello world", [0.1, 0.2, 0.3, 0.4]);

    const provB = fakeProvider("fake", "m2", 8);
    expect(reconcileEmbeddingSignature(db, provB)).toBe("wiped");
    expect(embeddingOf(id)).toBeNull();
    // Signature now pins the new provider — no second wipe.
    expect(reconcileEmbeddingSignature(db, provB)).toBe("match");
  });

  it("claims pre-signature vectors when the cache corroborates the provider", () => {
    const db = memory["db"];
    const prov = fakeProvider("fake", "m1", 4);
    insertChunk("hello", [0.1, 0.2, 0.3, 0.4]);
    db.prepare(
      "INSERT INTO embedding_cache (hash, provider, model, embedding, updated_at) VALUES ('h-hello', 'fake', 'm1', '[0.1,0.2,0.3,0.4]', ?)"
    ).run(Date.now());

    expect(reconcileEmbeddingSignature(db, prov)).toBe("adopted");
    expect(countChunksMissingEmbedding(db)).toBe(0);
  });

  it("wipes pre-signature vectors when nothing ties them to the current provider", () => {
    const db = memory["db"];
    const id = insertChunk("hello", [0.1, 0.2, 0.3, 0.4]);
    const prov = fakeProvider("fake", "m1", 4);

    expect(reconcileEmbeddingSignature(db, prov)).toBe("wiped");
    expect(embeddingOf(id)).toBeNull();
  });

  it("does NOT wipe when falling back to local — degraded, vectors intact", () => {
    const db = memory["db"];
    const real = fakeProvider("ollama", "mxbai", 4);
    reconcileEmbeddingSignature(db, real);
    const id = insertChunk("hello", [0.1, 0.2, 0.3, 0.4]);

    const local = fakeProvider("local", "tfidf", 16);
    expect(reconcileEmbeddingSignature(db, local)).toBe("degraded");
    expect(embeddingOf(id)).toEqual([0.1, 0.2, 0.3, 0.4]);
    // The real provider coming back is a plain match — still no wipe.
    expect(reconcileEmbeddingSignature(db, real)).toBe("match");
    expect(embeddingOf(id)).toEqual([0.1, 0.2, 0.3, 0.4]);
  });
});

describe("reembedMissingChunks", () => {
  it("fills every NULL embedding and leaves existing ones alone", async () => {
    const db = memory["db"];
    const prov = fakeProvider("fake", "m1", 4);
    reconcileEmbeddingSignature(db, prov);

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
