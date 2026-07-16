/**
 * Embedding storage format: float32 blobs, with legacy JSON text still
 * readable while the background conversion drains.
 *
 * The measurement that drove this (17,843-chunk corpus): 217 MB of JSON text,
 * 380 ms JSON.parse + 266 ms sqlite read, against 15 ms of cosine math. The
 * format was the cost, not the algorithm.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";

import { decodeEmbedding, encodeEmbedding } from "./embedding-codec.js";
import { convertTextEmbeddingsToBlobs, countTextEmbeddings } from "./index-embedding-blob-migration.js";

const vec = (n: number): number[] =>
  Array.from({ length: n }, (_, i) => Math.sin(i * 0.37) * 0.5);

describe("embedding codec", () => {
  it("round-trips a vector within float32 precision", () => {
    const v = vec(1024);
    const out = decodeEmbedding(encodeEmbedding(v));
    expect(out).not.toBeNull();
    expect(out!.length).toBe(1024);
    for (let i = 0; i < v.length; i++) expect(Math.abs(out![i] - v[i])).toBeLessThan(1e-6);
  });

  it("stores 4 bytes per component — the size win over JSON text", () => {
    const v = vec(1024);
    expect(encodeEmbedding(v).byteLength).toBe(4096);
    // The format it replaces cost ~3x this per vector.
    expect(JSON.stringify(v).length).toBeGreaterThan(4096 * 2);
  });

  it("still reads legacy JSON text rows", () => {
    const v = vec(8);
    expect(decodeEmbedding(JSON.stringify(v))).toEqual(v);
  });

  it("returns null for unreadable values rather than scoring garbage", () => {
    expect(decodeEmbedding(null)).toBeNull();
    expect(decodeEmbedding(undefined)).toBeNull();
    expect(decodeEmbedding("not json")).toBeNull();
    expect(decodeEmbedding('{"a":1}')).toBeNull();
    expect(decodeEmbedding(Buffer.alloc(0))).toBeNull();
    expect(decodeEmbedding(Buffer.alloc(7))).toBeNull(); // not a whole number of float32s
  });

  it("decodes a blob sitting at an unaligned byteOffset", () => {
    // better-sqlite3 gives back Buffers with no alignment guarantee; a naive
    // Float32Array cast throws on these.
    const v = vec(16);
    const packed = encodeEmbedding(v);
    const shifted = Buffer.alloc(packed.byteLength + 1);
    packed.copy(shifted, 1);
    const view = shifted.subarray(1);
    expect(view.byteOffset % 4).not.toBe(0);
    const out = decodeEmbedding(view);
    expect(out).not.toBeNull();
    for (let i = 0; i < v.length; i++) expect(Math.abs(out![i] - v[i])).toBeLessThan(1e-6);
  });
});

describe("embedding codec / worker parity", () => {
  // vector-search-worker.ts cannot import project modules (tsx worker
  // resolution — see its header), so it carries its own decode. Same contract
  // as the cosineSimilarity parity test: the copies must not drift.
  it("the worker's local decodeVec matches decodeEmbedding", async () => {
    const src = readFileSync(join(__dirname, "index-search", "vector-search-worker.ts"), "utf-8");
    const body = src.match(/function decodeVec\(value: unknown\): number\[\] \| null \{[\s\S]*?\n\}/)?.[0];
    expect(body, "worker decodeVec not found — did it get renamed?").toBeTruthy();
    const js = body!
      .replace(/: unknown/g, "").replace(/: number\[\] \| null/g, "")
      .replace(/: string/g, "").replace(/ as number\[\]/g, "")
      .replace(/const parsed: unknown/g, "const parsed")
      .replace(/new Array<number>/g, "new Array");
    const workerDecode = new Function(`${js}; return decodeVec;`)() as (v: unknown) => number[] | null;

    const cases: unknown[] = [
      encodeEmbedding(vec(64)), JSON.stringify(vec(8)),
      null, "not json", Buffer.alloc(0), Buffer.alloc(7),
    ];
    for (const c of cases) expect(workerDecode(c)).toEqual(decodeEmbedding(c));
  });
});

describe("text -> blob conversion", () => {
  const seed = (): InstanceType<typeof Database> => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE chunks (id INTEGER PRIMARY KEY, embedding TEXT)");
    return db;
  };

  it("converts legacy rows, is idempotent, and preserves the vectors", async () => {
    const db = seed();
    const v = vec(32);
    const ins = db.prepare("INSERT INTO chunks (embedding) VALUES (?)");
    for (let i = 0; i < 3; i++) ins.run(JSON.stringify(v));
    expect(countTextEmbeddings(db)).toBe(3);

    const first = await convertTextEmbeddingsToBlobs(db);
    expect(first).toEqual({ converted: 3, unreadable: 0 });
    expect(countTextEmbeddings(db)).toBe(0);

    const rows = db.prepare("SELECT embedding FROM chunks").all() as Array<{ embedding: unknown }>;
    for (const r of rows) {
      expect(Buffer.isBuffer(r.embedding)).toBe(true);
      const out = decodeEmbedding(r.embedding)!;
      for (let i = 0; i < v.length; i++) expect(Math.abs(out[i] - v[i])).toBeLessThan(1e-6);
    }

    // Second pass is a no-op — the work-list is empty.
    expect(await convertTextEmbeddingsToBlobs(db)).toEqual({ converted: 0, unreadable: 0 });
  });

  it("NULLs unreadable rows so re-embed rebuilds them instead of retrying forever", async () => {
    const db = seed();
    db.prepare("INSERT INTO chunks (embedding) VALUES (?)").run("{corrupt");
    const r = await convertTextEmbeddingsToBlobs(db);
    expect(r).toEqual({ converted: 0, unreadable: 1 });
    expect(db.prepare("SELECT embedding FROM chunks").get()).toEqual({ embedding: null });
    expect(countTextEmbeddings(db)).toBe(0);
  });

  it("leaves already-converted blobs alone", async () => {
    const db = seed();
    db.prepare("INSERT INTO chunks (embedding) VALUES (?)").run(encodeEmbedding(vec(4)));
    expect(countTextEmbeddings(db)).toBe(0);
    expect(await convertTextEmbeddingsToBlobs(db)).toEqual({ converted: 0, unreadable: 0 });
  });
});
