/**
 * The embedding self-heals are format-coupled, and moving storage to float32
 * blobs would have silently retired all three:
 *
 *   - nullDimensionMismatchedEmbeddings used json_array_length(), which throws
 *     on a blob — and its catch returned 0, reporting "nothing to heal".
 *   - nullZeroVectorEmbeddings used `embedding NOT GLOB '*[1-9]*'`, a test that
 *     only means anything against JSON text.
 *   - purgeZeroVectorEmbeddingCache used that same GLOB.
 *
 * Those are the degraded-mode poison guards (86ff12ff). A self-heal that stops
 * firing is invisible — nothing errors, recall just quietly rots. These lock
 * both encodings, since text and blob rows coexist while the conversion drains.
 */
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";

import { encodeEmbedding } from "./embedding-codec.js";
import {
  nullDimensionMismatchedEmbeddings,
  nullZeroVectorEmbeddings,
  purgeZeroVectorEmbeddingCache,
} from "./index-embedding-reconcile.js";
import type { EmbeddingProvider } from "./types.js";

const provider = { name: "ollama", model: "mxbai-embed-large", dimensions: 8 } as EmbeddingProvider;
const real = (n: number): number[] => Array.from({ length: n }, (_, i) => 0.1 + i * 0.01);
const zeros = (n: number): number[] => new Array(n).fill(0);

let db: InstanceType<typeof Database>;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE chunks (id INTEGER PRIMARY KEY, embedding TEXT);
    CREATE TABLE embedding_cache (hash TEXT, provider TEXT, model TEXT, embedding TEXT, updated_at INTEGER);
  `);
});

const ids = (): number[] =>
  (db.prepare("SELECT id FROM chunks WHERE embedding IS NOT NULL ORDER BY id").all() as Array<{ id: number }>)
    .map((r) => r.id);

describe("dimension self-heal across both encodings", () => {
  it("NULLs wrong-dimension blobs and keeps correct ones", async () => {
    const ins = db.prepare("INSERT INTO chunks (id, embedding) VALUES (?, ?)");
    ins.run(1, encodeEmbedding(real(8)));   // correct
    ins.run(2, encodeEmbedding(real(1024))); // stale model, wrong dims
    ins.run(3, encodeEmbedding(real(4)));    // wrong dims

    expect(await nullDimensionMismatchedEmbeddings(db, provider)).toBe(2);
    expect(ids()).toEqual([1]);
  });

  it("still NULLs wrong-dimension legacy text rows", async () => {
    const ins = db.prepare("INSERT INTO chunks (id, embedding) VALUES (?, ?)");
    ins.run(1, JSON.stringify(real(8)));
    ins.run(2, JSON.stringify(real(4)));

    expect(await nullDimensionMismatchedEmbeddings(db, provider)).toBe(1);
    expect(ids()).toEqual([1]);
  });

  it("heals a mixed corpus mid-conversion", async () => {
    const ins = db.prepare("INSERT INTO chunks (id, embedding) VALUES (?, ?)");
    ins.run(1, encodeEmbedding(real(8)));    // converted, correct
    ins.run(2, JSON.stringify(real(8)));      // not yet converted, correct
    ins.run(3, encodeEmbedding(real(4)));     // converted, wrong dims
    ins.run(4, JSON.stringify(real(4)));      // not yet converted, wrong dims

    expect(await nullDimensionMismatchedEmbeddings(db, provider)).toBe(2);
    expect(ids()).toEqual([1, 2]);
  });
});

describe("all-zero poison self-heal across both encodings", () => {
  it("NULLs an all-zero blob and spares real vectors", async () => {
    const ins = db.prepare("INSERT INTO chunks (id, embedding) VALUES (?, ?)");
    ins.run(1, encodeEmbedding(real(8)));
    ins.run(2, encodeEmbedding(zeros(8)));

    expect(await nullZeroVectorEmbeddings(db)).toBe(1);
    expect(ids()).toEqual([1]);
  });

  it("still NULLs an all-zero legacy text vector", async () => {
    const ins = db.prepare("INSERT INTO chunks (id, embedding) VALUES (?, ?)");
    ins.run(1, JSON.stringify(real(8)));
    ins.run(2, JSON.stringify(zeros(8)));

    expect(await nullZeroVectorEmbeddings(db)).toBe(1);
    expect(ids()).toEqual([1]);
  });

  it("does not mistake a real blob for poison — regression on the GLOB port", async () => {
    // A real float32 vector's bytes are arbitrary; a text-oriented GLOB aimed
    // at a blob could match or not for reasons unrelated to its values.
    const ins = db.prepare("INSERT INTO chunks (id, embedding) VALUES (?, ?)");
    for (let i = 1; i <= 20; i++) ins.run(i, encodeEmbedding(real(8).map((v) => v * i)));
    expect(await nullZeroVectorEmbeddings(db)).toBe(0);
    expect(ids().length).toBe(20);
  });
});

describe("zero-vector cache purge across both encodings", () => {
  it("purges all-zero blob and text rows, keeps real ones", () => {
    const ins = db.prepare("INSERT INTO embedding_cache VALUES (?, 'ollama', 'm', ?, 0)");
    ins.run("a", encodeEmbedding(real(8)));
    ins.run("b", encodeEmbedding(zeros(8)));
    ins.run("c", JSON.stringify(real(8)));
    ins.run("d", JSON.stringify(zeros(8)));

    expect(purgeZeroVectorEmbeddingCache(db)).toBe(2);
    expect(
      (db.prepare("SELECT hash FROM embedding_cache ORDER BY hash").all() as Array<{ hash: string }>)
        .map((r) => r.hash)
    ).toEqual(["a", "c"]);
  });
});
