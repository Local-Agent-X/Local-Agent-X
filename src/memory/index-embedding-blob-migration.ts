/**
 * One-way conversion of stored embeddings from legacy JSON text to float32
 * blobs (see embedding-codec.ts for why the format changed).
 *
 * NOT a schema migration. index-schema-migrations.ts runs its whole ladder
 * inside one boot transaction, and rewriting a 217 MB corpus there would stall
 * startup and balloon the WAL. Because decodeEmbedding() reads both encodings,
 * conversion needs no flag day: it drains in batches in the background while
 * search keeps serving text rows that haven't been reached yet.
 *
 * Idempotent and resumable by construction — the work-list is exactly
 * `typeof(embedding) = 'text'`, which shrinks monotonically. A crash mid-drain
 * just leaves fewer rows for the next boot. Rows whose text won't parse are
 * NULLed rather than skipped, so reembedMissingChunks rebuilds them instead of
 * them being retried on every boot forever.
 */
import type Database from "better-sqlite3";

import { createLogger } from "../logger.js";
import { decodeEmbedding, encodeEmbedding } from "./embedding-codec.js";
import { yieldEventLoop } from "./index-embedding-reconcile.js";

const logger = createLogger("memory.embedding-blob-migration");

const BATCH_ROWS = 500;

export function countTextEmbeddings(db: InstanceType<typeof Database>): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE typeof(embedding) = 'text'")
      .get() as { n: number }
  ).n;
}

/**
 * Convert every legacy text embedding to a blob. Returns what it did; safe to
 * call on an already-converted corpus (the work-list is empty and it no-ops).
 */
export async function convertTextEmbeddingsToBlobs(
  db: InstanceType<typeof Database>
): Promise<{ converted: number; unreadable: number }> {
  const select = db.prepare(
    "SELECT id, embedding FROM chunks WHERE typeof(embedding) = 'text' ORDER BY id LIMIT ?"
  );
  const update = db.prepare("UPDATE chunks SET embedding = ? WHERE id = ?");

  let converted = 0;
  let unreadable = 0;

  for (;;) {
    const rows = select.all(BATCH_ROWS) as Array<{ id: number; embedding: unknown }>;
    if (rows.length === 0) break;

    // One transaction per batch: each is independently durable, so a crash
    // costs at most this batch. No re-selection hazard — every row written
    // here leaves the work-list (text -> blob), so the next pass sees the rest.
    db.transaction(() => {
      for (const row of rows) {
        const vec = decodeEmbedding(row.embedding);
        if (!vec || vec.length === 0) {
          update.run(null, row.id);
          unreadable++;
          continue;
        }
        update.run(encodeEmbedding(vec), row.id);
        converted++;
      }
    })();

    await yieldEventLoop();
  }

  if (converted > 0 || unreadable > 0) {
    logger.info(
      `[memory] embedding storage: converted ${converted} vectors to float32 blobs` +
      (unreadable > 0 ? `, NULLed ${unreadable} unreadable (queued for re-embed)` : "")
    );
  }
  return { converted, unreadable };
}

// Per-database guard: one drain at a time, but tests (and any future
// multi-index process) open several databases and must not block each other.
const draining = new WeakSet<object>();

/**
 * Fire-and-forget the drain, then hand control back via onSettled — which is
 * where the caller kicks its re-embed, so rows this NULLs as unreadable get
 * rebuilt in the same boot instead of waiting for the next one. onSettled runs
 * on every path, including "nothing to convert" and failure.
 *
 * Pure re-encode with no provider calls, so it is safe to run even in the
 * degraded local-fallback state where re-embedding is correctly skipped.
 */
export function kickBackgroundBlobConversion(
  db: InstanceType<typeof Database>,
  onSettled: () => void
): void {
  if (draining.has(db)) return;
  const pending = countTextEmbeddings(db);
  if (pending === 0) { onSettled(); return; }
  draining.add(db);
  logger.info(`[memory] Converting ${pending} embeddings to float32 blob storage`);
  void convertTextEmbeddingsToBlobs(db)
    .catch((e) => logger.warn(`[memory] Embedding blob conversion failed: ${(e as Error).message}`))
    .finally(() => { draining.delete(db); onSettled(); });
}
