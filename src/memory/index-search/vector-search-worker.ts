// Memory vector scan + its worker-thread bootstrap.
//
// The full-corpus cosine scan blocks whatever event loop it runs on for
// seconds at 45k-chunk scale (measured 13-21s), which froze the whole server
// when it ran on the main loop. searchVectorOffThread (vector-search.ts)
// spawns this file as a worker so the scan burns a pool thread instead.
//
// WHY THE SCAN LIVES IN THE WORKER FILE: a worker entry loaded under tsx
// cannot resolve relative ".js" specifiers back to ".ts" sources (the
// alias only works for modules inside tsx's main-thread namespace), so this
// file must not import project modules at runtime — only bare packages,
// node builtins, and erased `import type`. The main thread imports
// scanChunks from here, so both paths execute the exact same code.
//
// One-shot protocol: request arrives via workerData, one response is posted,
// the readonly connection is closed. Each batch is its own implicit
// transaction — no long-held snapshot pinning the WAL.

import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import type { Chunk } from "../types.js";

// Local copy of memory/embedding-codec.ts decodeEmbedding — this file cannot
// import it (see header). embedding-codec.parity.test.ts locks the two
// implementations together. Reads blobs (current) and legacy JSON text (rows
// the background conversion hasn't reached yet).
function decodeVec(value: unknown): number[] | null {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as number[]) : null;
    } catch {
      return null;
    }
  }
  if (value instanceof Uint8Array) {
    if (value.byteLength === 0 || value.byteLength % 4 !== 0) return null;
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    const out = new Array<number>(value.byteLength / 4);
    for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
    return out;
  }
  return null;
}

// Local copy of memory/utils.ts cosineSimilarity — this file cannot import
// it (see header). The parity test locks the two implementations together.
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function scanChunks(
  db: InstanceType<typeof Database>,
  queryVec: number[],
  limit: number,
  sources?: string[],
  sessionFilter?: string | null
): Array<Chunk & { score: number }> {
  const BATCH_SIZE = 1000;
  const sourceFilter = sources ? `AND source IN (${sources.map(() => "?").join(",")})` : "";
  // Same source-authoritative gate as searchKeyword.
  const sessionWhere = sessionFilter !== undefined
    ? `AND (source IN ('entity', 'mind', 'personality', 'import')${sessionFilter ? " OR session_id = ?" : ""})`
    : "";
  const baseParams: unknown[] = sources ? [...sources] : [];
  const params = sessionFilter ? [...baseParams, sessionFilter] : baseParams;

  // Keyset pagination (id > lastId) instead of LIMIT/OFFSET: each batch is
  // its own short read, stable under the concurrent yielding embedding wipes
  // (OFFSET pagination skips surviving rows when deletes interleave between
  // batches) and avoids the O(n²) rescan cost of growing offsets.
  const batchStmt = db.prepare(
    `SELECT id, path, source, start_line, end_line, text, embedding, metadata, session_id, updated_at
     FROM chunks WHERE embedding IS NOT NULL ${sourceFilter} ${sessionWhere} AND id > ?
     ORDER BY id LIMIT ?`
  );

  const results: Array<Chunk & { score: number }> = [];
  let minResultScore = -Infinity;
  let lastId = -1;

  for (;;) {
    const batch = batchStmt.all(...params, lastId, BATCH_SIZE) as Array<{
      id: number;
      path: string;
      source: string;
      start_line: number;
      end_line: number;
      text: string;
      embedding: unknown;
      metadata: string | null;
      session_id: string | null;
      updated_at: number;
    }>;
    if (batch.length === 0) break;
    lastId = batch[batch.length - 1].id;

    for (const row of batch) {
      const embedding = decodeVec(row.embedding);
      if (!embedding) continue;

      const similarity = cosine(queryVec, embedding);
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

export interface VectorScanRequest {
  dbPath: string;
  queryVec: number[];
  limit: number;
  sources?: string[];
  sessionFilter?: string | null;
}

function isScanRequest(data: unknown): data is VectorScanRequest {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return typeof d.dbPath === "string" && Array.isArray(d.queryVec) && typeof d.limit === "number";
}

// Bootstrap. The workerData shape check matters: this module is also
// imported by the main thread (for scanChunks), and under vitest's threads
// pool that "main thread" is itself a worker with a live parentPort — the
// scan must only run for OUR spawn, never on plain import.
if (parentPort && isScanRequest(workerData)) {
  const request = workerData;
  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(request.dbPath, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 5000");
    const results = scanChunks(
      db,
      request.queryVec,
      request.limit,
      request.sources,
      request.sessionFilter
    );
    parentPort.postMessage({ ok: true, results });
  } catch (e) {
    parentPort.postMessage({ ok: false, message: (e as Error).message || String(e) });
  } finally {
    try {
      db?.close();
    } catch {}
  }
}
