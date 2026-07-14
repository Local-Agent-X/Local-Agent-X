import type Database from "better-sqlite3";
import type { Chunk, EmbeddingProvider, MemoryConfig } from "./types.js";
import { sleep } from "./utils.js";
import { yieldEventLoop } from "./index-embedding-reconcile.js";

import { createLogger } from "../logger.js";
const logger = createLogger("memory.index-embedding");

// Provider signature reconciliation + vector-table lifecycle live in their
// own module (one responsibility per file); re-exported so callers keep the
// single index-embedding entry point.
export {
  initVectorTable,
  yieldEventLoop,
  embeddingSignature,
  reconcileEmbeddingSignature,
  countChunksMissingEmbedding,
  nullDimensionMismatchedEmbeddings,
  attachEmbeddingProvider,
  type SignatureVerdict,
} from "./index-embedding-reconcile.js";

export async function embedChunksWithRetry(
  db: InstanceType<typeof Database>,
  embeddingProvider: EmbeddingProvider | null,
  config: MemoryConfig,
  chunks: Chunk[]
): Promise<void> {
  if (!embeddingProvider) return;

  const provider = embeddingProvider;
  const textsToEmbed: string[] = [];
  const cachedEmbeddings = new Map<number, number[]>();

  for (let i = 0; i < chunks.length; i++) {
    const cached = getCachedEmbedding(db, chunks[i].hash, provider.name, provider.model);
    if (cached) {
      cachedEmbeddings.set(i, cached);
    } else {
      textsToEmbed.push(chunks[i].text);
    }
  }

  let newEmbeddings: number[][] = [];
  if (textsToEmbed.length > 0) {
    newEmbeddings = await embedWithRetry(embeddingProvider, config, textsToEmbed);
  }

  let newIdx = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (cachedEmbeddings.has(i)) {
      chunks[i].embedding = cachedEmbeddings.get(i);
    } else if (newIdx < newEmbeddings.length) {
      const vec = newEmbeddings[newIdx];
      if (vec.length === 0 || vec.every((v) => v === 0)) {
        // Degraded-mode placeholder from the provider — leave the chunk
        // vectorless (keyword-searchable) instead of indexing a zero vector.
        newIdx++;
        continue;
      }
      chunks[i].embedding = vec;
      cacheEmbedding(
        db,
        chunks[i].hash,
        provider.name,
        provider.model,
        chunks[i].embedding!
      );
      newIdx++;
    }
  }
}

async function embedWithRetry(
  embeddingProvider: EmbeddingProvider,
  config: MemoryConfig,
  texts: string[]
): Promise<number[][]> {
  const { retryMaxAttempts, retryBaseDelayMs, retryMaxDelayMs } = config;
  const startTime = Date.now();
  const TOTAL_TIMEOUT_MS = Math.min(300_000, Math.max(60_000, texts.length * 15_000));

  for (let attempt = 1; attempt <= retryMaxAttempts; attempt++) {
    if (Date.now() - startTime > TOTAL_TIMEOUT_MS) {
      logger.warn(`[memory] Embedding total timeout exceeded (${TOTAL_TIMEOUT_MS / 1000}s)`);
      break;
    }

    try {
      const result = await Promise.race([
        embeddingProvider.embedBatch(texts),
        sleep(TOTAL_TIMEOUT_MS).then(() => {
          throw new Error("Embedding request timed out");
        }),
      ]);
      return result;
    } catch (e) {
      const msg = (e as Error).message;
      logger.warn(
        `[memory] Embedding attempt ${attempt}/${retryMaxAttempts} failed: ${msg}`
      );

      if (attempt < retryMaxAttempts) {
        const delay = Math.min(
          retryBaseDelayMs * Math.pow(2, attempt - 1),
          retryMaxDelayMs
        );
        await sleep(delay);
      }
    }
  }

  logger.warn(
    `[memory] All embedding attempts exhausted — ${texts.length} chunks will lack vectors`
  );
  return [];
}

export function getCachedEmbedding(
  db: InstanceType<typeof Database>,
  hash: string,
  provider: string,
  model: string
): number[] | null {
  const row = db
    .prepare(
      "SELECT embedding FROM embedding_cache WHERE hash = ? AND provider = ? AND model = ?"
    )
    .get(hash, provider, model) as { embedding: string } | undefined;
  if (!row) return null;
  try {
    db
      .prepare(
        "UPDATE embedding_cache SET updated_at = ? WHERE hash = ? AND provider = ? AND model = ?"
      )
      .run(Date.now(), hash, provider, model);
    return JSON.parse(row.embedding);
  } catch {
    return null;
  }
}

export function cacheEmbedding(
  db: InstanceType<typeof Database>,
  hash: string,
  provider: string,
  model: string,
  embedding: number[]
): void {
  // All-zero vectors are the providers' degraded-mode value (Ollama wedged,
  // key missing), not data. Persisting one poisons recall for that chunk
  // permanently — it would never be re-embedded once the provider recovers.
  if (embedding.length === 0 || embedding.every((v) => v === 0)) return;
  db
    .prepare(
      `INSERT OR REPLACE INTO embedding_cache (hash, provider, model, embedding, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(hash, provider, model, JSON.stringify(embedding), Date.now());
}

/**
 * Embed every chunk whose vector is missing — after a provider wipe, a
 * crash mid-embed, or an exhausted-retries failure during normal indexing.
 * Single id-ordered pass, small batches, resumable: anything still NULL
 * when this returns gets picked up on the next boot.
 */
export async function reembedMissingChunks(
  db: InstanceType<typeof Database>,
  provider: EmbeddingProvider,
  config: MemoryConfig,
  hasVec: boolean
): Promise<{ embedded: number; missing: number }> {
  const BATCH = 32;
  const select = db.prepare(
    "SELECT id, text, hash FROM chunks WHERE embedding IS NULL AND id > ? ORDER BY id LIMIT ?"
  );
  const update = db.prepare("UPDATE chunks SET embedding = ? WHERE id = ?");
  const insVec = hasVec
    ? db.prepare("INSERT OR REPLACE INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)")
    : null;

  let embedded = 0;
  let missing = 0;
  let afterId = -1;

  for (;;) {
    const rows = select.all(afterId, BATCH) as Array<{ id: number; text: string; hash: string }>;
    await yieldEventLoop();
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1].id;

    const chunks = rows.map((r) => ({
      id: r.id, text: r.text, hash: r.hash,
      path: "", source: "", startLine: 0, endLine: 0,
    })) as Chunk[];
    await embedChunksWithRetry(db, provider, config, chunks);

    db.transaction(() => {
      for (const c of chunks) {
        if (!c.embedding) { missing++; continue; }
        update.run(JSON.stringify(c.embedding), c.id);
        if (insVec) {
          try { insVec.run(c.id, new Float32Array(c.embedding)); } catch {}
        }
        embedded++;
      }
    })();
    await yieldEventLoop();

    // Full-batch failure means the provider is down — stop burning retries;
    // the next boot resumes from whatever is still NULL.
    if (chunks.every((c) => !c.embedding)) {
      missing += (
        db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NULL AND id > ?").get(afterId) as { n: number }
      ).n;
      break;
    }
    await sleep(50);
  }

  return { embedded, missing };
}

export function pruneEmbeddingCache(
  db: InstanceType<typeof Database>,
  config: MemoryConfig
): void {
  const max = config.embeddingCacheMaxEntries;
  const count = (
    db.prepare("SELECT COUNT(*) as n FROM embedding_cache").get() as { n: number }
  ).n;

  if (count <= max) return;

  const toDelete = count - max;
  db
    .prepare(
      `DELETE FROM embedding_cache WHERE rowid IN (
        SELECT rowid FROM embedding_cache ORDER BY updated_at ASC LIMIT ?
      )`
    )
    .run(toDelete);

  logger.info(`[memory] Pruned ${toDelete} stale embedding cache entries`);
}
