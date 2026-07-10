import { statSync } from "node:fs";
import type Database from "better-sqlite3";
import type { Chunk, EmbeddingProvider, MemoryConfig } from "./types.js";
import { embedChunksWithRetry } from "./index-embedding.js";
import { withChunkProvenance } from "./search-helpers.js";

import { createLogger } from "../logger.js";
const logger = createLogger("memory.index-ingest");

export async function indexChunks(
  db: InstanceType<typeof Database>,
  embeddingProvider: EmbeddingProvider | null,
  config: MemoryConfig,
  hasFts: boolean,
  hasVec: boolean,
  removeFile: (path: string) => void,
  chunks: Chunk[],
  virtualPath: string,
  source: string
): Promise<void> {
  removeFile(virtualPath);
  if (chunks.length === 0) return;
  for (const chunk of chunks) {
    chunk.metadata = withChunkProvenance(source, chunk.metadata ?? {});
  }
  if (embeddingProvider) {
    try {
      await embedChunksWithRetry(db, embeddingProvider, config, chunks);
    } catch (e) {
      // Never swallow: an unexpected throw here (not the normal retry-exhaustion
      // path, which resolves with no vectors) still leaves chunks unembedded.
      logger.error(`[memory] Embedding step threw for ${virtualPath}:`, (e as Error).message);
    }
    // embedChunksWithRetry resolves even when the provider is down (it exhausts
    // its retries and returns no vectors), so success here does NOT mean the
    // chunks got embedded. Count what actually came back: any left unembedded
    // are inserted keyword-searchable and will be re-vectorised by the boot-time
    // background backfill once the provider returns — but if we log nothing, a
    // wholesale-failed import (e.g. Ollama down) is silently vector-invisible and
    // the caller marks it ingested. Surface the gap so it is observable.
    const unembedded = chunks.reduce((n, c) => n + (c.embedding ? 0 : 1), 0);
    if (unembedded > 0) {
      logger.warn(
        `[memory] ${unembedded}/${chunks.length} chunk(s) for ${virtualPath} indexed WITHOUT embeddings ` +
        `(vector-invisible until background re-embed) — embedding provider likely unavailable`
      );
    }
  }

  const now = Date.now();
  try {
    const insertChunk = db.prepare(`
      INSERT INTO chunks (path, source, start_line, end_line, text, hash, content_hash, embedding, updated_at, metadata, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = hasFts ? db.prepare(`INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)`) : null;

    for (const chunk of chunks) {
      try {
        const result = insertChunk.run(
          virtualPath, source, chunk.startLine, chunk.endLine, chunk.text, chunk.hash, chunk.hash,
          chunk.embedding ? JSON.stringify(chunk.embedding) : null, now,
          chunk.metadata ? JSON.stringify(chunk.metadata) : null,
          chunk.metadata?.session_id ?? null
        );
        const chunkId = result.lastInsertRowid;
        if (insertFts) try { insertFts.run(chunkId, chunk.text); } catch {}
        if (hasVec && chunk.embedding) {
          try { db.prepare("INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)").run(chunkId, new Float32Array(chunk.embedding)); } catch {}
        }
      } catch (e) {
        logger.warn(`[memory] Chunk insert failed:`, (e as Error).message);
      }
    }
    db.prepare("INSERT OR REPLACE INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)").run(virtualPath, source, `ingest:${now}`, now, 0);
  } catch (e) {
    logger.error(`[memory] indexChunks transaction failed for ${virtualPath}:`, (e as Error).message);
  }
}

export async function indexChunksIdempotent(
  db: InstanceType<typeof Database>,
  embeddingProvider: EmbeddingProvider | null,
  config: MemoryConfig,
  hasFts: boolean,
  hasVec: boolean,
  chunks: Chunk[],
  virtualPath: string,
  source: string
): Promise<{ added: number; removed: number; unchanged: number }> {
  for (const chunk of chunks) {
    chunk.metadata = withChunkProvenance(source, chunk.metadata ?? {});
  }
  const existing = db
    .prepare("SELECT id, content_hash FROM chunks WHERE path = ?")
    .all(virtualPath) as Array<{ id: number; content_hash: string | null }>;

  const existingByHash = new Map<string, number>();
  for (const row of existing) {
    if (row.content_hash) existingByHash.set(row.content_hash, row.id);
  }
  const incomingHashes = new Set(chunks.map((c) => c.hash));

  const toDelete = existing.filter(
    (r) => !r.content_hash || !incomingHashes.has(r.content_hash)
  );
  const toInsert = chunks.filter((c) => !existingByHash.has(c.hash));

  if (toDelete.length === 0 && toInsert.length === 0) {
    return { added: 0, removed: 0, unchanged: existing.length };
  }

  if (toInsert.length > 0 && embeddingProvider) {
    try { await embedChunksWithRetry(db, embeddingProvider, config, toInsert); }
    catch { /* keyword search still works without embeddings */ }
  }

  const now = Date.now();

  // Lane-seam stamp. For a REAL on-disk file, record files.hash in the sync
  // lane's own "<mtimeMs>:<size>" format (what listMemoryFiles computes) so
  // the next search-triggered syncIndex sees the untouched file as unchanged
  // and skips it. The previous opaque "idempotent:<ts>" stamp could NEVER
  // match, so every idempotent-indexed file was perpetually full-reindexed by
  // every sync pass — churn (re-chunk + re-embed) AND, because indexFile
  // re-chunks with different geometry (1600-char windows vs sections), a
  // clock re-stamp that made 90-day-old facts read "just now". Virtual paths
  // (import/…, session-live/…) have no file to stat and keep the old stamp.
  let fileHash = `idempotent:${now}`;
  let fileMtime = now;
  let fileSize = 0;
  try {
    const st = statSync(virtualPath);
    fileHash = `${st.mtimeMs}:${st.size}`;
    fileMtime = st.mtimeMs;
    fileSize = st.size;
  } catch { /* virtual path — keep the opaque idempotent stamp */ }

  try {
    const txn = db.transaction(() => {
      const delChunk = db.prepare("DELETE FROM chunks WHERE id = ?");
      const delFts = hasFts ? db.prepare("DELETE FROM chunks_fts WHERE rowid = ?") : null;
      const delVec = hasVec ? db.prepare("DELETE FROM chunks_vec WHERE chunk_id = ?") : null;
      for (const row of toDelete) {
        if (delFts) try { delFts.run(row.id); } catch {}
        if (delVec) try { delVec.run(row.id); } catch {}
        delChunk.run(row.id);
      }

      const insertChunk = db.prepare(`
        INSERT INTO chunks (path, source, start_line, end_line, text, hash, content_hash, embedding, updated_at, metadata, session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertFts = hasFts ? db.prepare("INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)") : null;
      const insertVec = hasVec ? db.prepare("INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)") : null;
      for (const chunk of toInsert) {
        const res = insertChunk.run(
          virtualPath, source, chunk.startLine, chunk.endLine, chunk.text, chunk.hash, chunk.hash,
          chunk.embedding ? JSON.stringify(chunk.embedding) : null, now,
          chunk.metadata ? JSON.stringify(chunk.metadata) : null,
          chunk.metadata?.session_id ?? null
        );
        const id = res.lastInsertRowid;
        if (insertFts) try { insertFts.run(id, chunk.text); } catch {}
        if (insertVec && chunk.embedding) {
          try { insertVec.run(id, new Float32Array(chunk.embedding)); } catch {}
        }
      }

      db.prepare(
        "INSERT OR REPLACE INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)"
      ).run(virtualPath, source, fileHash, fileMtime, fileSize);
    });
    txn();
  } catch (e) {
    logger.error(`[memory] indexChunksIdempotent failed for ${virtualPath}:`, (e as Error).message);
    return { added: 0, removed: 0, unchanged: existing.length };
  }

  return {
    added: toInsert.length,
    removed: toDelete.length,
    unchanged: existing.length - toDelete.length,
  };
}

export function isConversationIngested(
  db: InstanceType<typeof Database>,
  conversationId: string
): boolean {
  const row = db.prepare("SELECT 1 FROM conversation_ingest_log WHERE conversation_id = ?").get(conversationId);
  return !!row;
}

export function markConversationIngested(
  db: InstanceType<typeof Database>,
  conversationId: string,
  title: string,
  createTime: number,
  messageCount: number,
  sourceFormat: string
): void {
  db.prepare(
    "INSERT OR REPLACE INTO conversation_ingest_log (conversation_id, title, create_time, message_count, source_format, ingested_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(conversationId, title, createTime, messageCount, sourceFormat, Date.now());
}

export function getIngestStats(
  db: InstanceType<typeof Database>
): { total: number; byFormat: Record<string, number> } {
  const total = (db.prepare("SELECT COUNT(*) as c FROM conversation_ingest_log").get() as { c: number }).c;
  const rows = db.prepare("SELECT source_format, COUNT(*) as c FROM conversation_ingest_log GROUP BY source_format").all() as Array<{ source_format: string; c: number }>;
  const byFormat: Record<string, number> = {};
  for (const r of rows) byFormat[r.source_format] = r.c;
  return { total, byFormat };
}

export interface IngestSourceSummary {
  source: string;
  conversations: number;
  messages: number;
  firstIngestedAt: number;
  lastIngestedAt: number;
}

export function getIngestSummary(
  db: InstanceType<typeof Database>
): IngestSourceSummary[] {
  return db.prepare(
    `SELECT source_format AS source,
            COUNT(*) AS conversations,
            COALESCE(SUM(message_count), 0) AS messages,
            MIN(ingested_at) AS firstIngestedAt,
            MAX(ingested_at) AS lastIngestedAt
       FROM conversation_ingest_log
       GROUP BY source_format
       ORDER BY lastIngestedAt DESC`
  ).all() as IngestSourceSummary[];
}

export function listConversationIdsBySource(
  db: InstanceType<typeof Database>,
  source: string
): string[] {
  const rows = db.prepare(
    "SELECT conversation_id FROM conversation_ingest_log WHERE source_format = ?"
  ).all(source) as Array<{ conversation_id: string }>;
  return rows.map(r => r.conversation_id);
}

export function listConversationIdsSince(
  db: InstanceType<typeof Database>,
  sinceMs: number
): Array<{ conversation_id: string; source_format: string; ingested_at: number; title: string | null }> {
  return db.prepare(
    `SELECT conversation_id, source_format, ingested_at, title
       FROM conversation_ingest_log
       WHERE ingested_at >= ?
       ORDER BY ingested_at DESC`
  ).all(sinceMs) as Array<{ conversation_id: string; source_format: string; ingested_at: number; title: string | null }>;
}
