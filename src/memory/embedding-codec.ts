/**
 * Single source of truth for how a chunk embedding is serialized.
 *
 * Embeddings were stored as JSON text: one 1024-d vector cost ~12.7 KB, so a
 * full-corpus scan read 217 MB and burned 380 ms in JSON.parse + 266 ms in
 * SQLite reads against 15 ms of actual cosine math (measured on a 17,843-chunk
 * corpus). The math was never the cost — the text format was. Float32 blobs
 * cut the same corpus to 73 MB and delete the parse step outright.
 *
 * decode() accepts BOTH blobs and legacy JSON text on purpose: the corpus
 * converts in batches in the background (index-embedding-blob-migration.ts),
 * so both encodings coexist until it drains. This is a read-compatibility
 * shim for a one-way migration, NOT a dual-format contract — every writer
 * emits blobs, and text rows only ever shrink in number.
 *
 * Precision: JS numbers are float64 and float32 costs ~1e-7 per component,
 * orders of magnitude below any similarity threshold in this codebase.
 * embedding-codec.test.ts pins the round-trip error.
 *
 * vector-search-worker.ts carries a byte-identical copy of decode() because a
 * tsx-loaded worker cannot import project modules (see its header for why).
 * embedding-codec.parity.test.ts locks the two together — the same treatment
 * cosineSimilarity already gets.
 */

/** Serialize a vector as little-endian float32. */
export function encodeEmbedding(vec: number[]): Buffer {
  const f = new Float32Array(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

/**
 * Deserialize whatever the column holds. Returns null for anything
 * unreadable — callers skip those chunks rather than scoring garbage.
 */
export function decodeEmbedding(value: unknown): number[] | null {
  if (value == null) return null;

  // Legacy JSON text (pre-blob rows still awaiting conversion).
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as number[]) : null;
    } catch {
      return null;
    }
  }

  // Float32 blob. better-sqlite3 hands back a Buffer that is NOT guaranteed
  // to be 4-byte aligned, so read through a DataView rather than casting to
  // Float32Array — the cast throws on an unaligned byteOffset.
  if (value instanceof Uint8Array) {
    if (value.byteLength === 0 || value.byteLength % 4 !== 0) return null;
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    const out = new Array<number>(value.byteLength / 4);
    for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
    return out;
  }

  return null;
}
