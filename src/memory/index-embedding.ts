import type Database from "better-sqlite3";
import type { Chunk, EmbeddingProvider, MemoryConfig } from "./types.js";
import { sleep } from "./utils.js";

import { createLogger } from "../logger.js";
const logger = createLogger("memory.index-embedding");

export function initVectorTable(
  db: InstanceType<typeof Database>,
  dims: number
): { hasVec: boolean } {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
        chunk_id INTEGER PRIMARY KEY,
        embedding FLOAT[${dims}]
      );
    `);
    return { hasVec: true };
  } catch {
    logger.info(
      "[memory] sqlite-vec not available — vector search will use in-memory cosine"
    );
    return { hasVec: false };
  }
}

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

// ── Provider signature reconciliation ──
//
// chunks.embedding rows are only comparable to query vectors from the SAME
// provider+model. Nothing used to record which provider wrote them, so a
// config change (or a lost API key) silently degraded vector search to
// garbage scores: same-dims model swaps produce plausible-but-wrong
// similarities, different-dims swaps score 0 everywhere. The signature in
// the meta table pins the vector space; on a real provider change we wipe
// stale vectors and let reembedMissingChunks rebuild them in the background.

const SIGNATURE_KEY = "embedding_signature";

// Full-table UPDATEs over a large chunk corpus (~45k rows observed) used to
// run as one synchronous statement on the main event loop, starving every
// concurrent awaited boot phase (measured: setupVoiceWs inflated 17-21s).
const UPDATE_BATCH_ROWS = 4000;

function yieldEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

// NULL chunk embeddings matching the AND-appended predicate, batched by rowid
// with an event-loop yield between batches. Each batch UPDATE is atomic; rows
// inserted after the bounds snapshot carry vectors from the CURRENT provider
// (callers set the provider before invoking) and are correctly left alone.
async function nullEmbeddingsInBatches(
  db: InstanceType<typeof Database>,
  predicateSql: string,
  params: readonly unknown[]
): Promise<number> {
  const bounds = db
    .prepare("SELECT MIN(rowid) AS lo, MAX(rowid) AS hi FROM chunks")
    .get() as { lo: number | null; hi: number | null };
  if (bounds.lo === null || bounds.hi === null) return 0;

  const stmt = db.prepare(
    "UPDATE chunks SET embedding = NULL " +
    `WHERE rowid BETWEEN ? AND ? AND embedding IS NOT NULL${predicateSql}`
  );
  let changed = 0;
  for (let lo = bounds.lo; lo <= bounds.hi; lo += UPDATE_BATCH_ROWS) {
    const hi = Math.min(lo + UPDATE_BATCH_ROWS - 1, bounds.hi);
    changed += stmt.run(lo, hi, ...params).changes;
    await yieldEventLoop();
  }
  return changed;
}

export function embeddingSignature(p: EmbeddingProvider): string {
  return `${p.name}/${p.model}/${p.dimensions}`;
}

export type SignatureVerdict = "match" | "adopted" | "wiped" | "degraded";

export async function reconcileEmbeddingSignature(
  db: InstanceType<typeof Database>,
  provider: EmbeddingProvider
): Promise<SignatureVerdict> {
  const sig = embeddingSignature(provider);
  const row = db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get(SIGNATURE_KEY) as { value: string } | undefined;
  const stored = row?.value;
  if (stored === sig) return "match";

  // `local` is the silent no-API-key fallback (see embedding-providers/index.ts).
  // A transient key failure must NOT wipe a real provider's vectors — that
  // would force a full paid re-embed on every flap. Leave the signature and
  // vectors alone; different dims make stale vectors score ~0, so search
  // degrades to keyword-only until the configured provider is back.
  if (stored && provider.name === "local") {
    logger.warn(
      `[memory] Embedding provider fell back to local (vectors are ${stored}) — ` +
      `vector search degraded until the configured provider returns`
    );
    return "degraded";
  }

  const setSig = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");

  if (!stored) {
    // Pre-signature deployment. Vectors written before tracking existed are
    // claimed for the current provider only when the cache corroborates it;
    // otherwise they came from some earlier configuration and must go.
    const embedded = (
      db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL").get() as { n: number }
    ).n;
    const cachedForCurrent = embedded === 0 ? 0 : (
      db.prepare("SELECT COUNT(*) AS n FROM embedding_cache WHERE provider = ? AND model = ?")
        .get(provider.name, provider.model) as { n: number }
    ).n;
    if (embedded === 0 || cachedForCurrent > 0) {
      setSig.run(SIGNATURE_KEY, sig);
      return "adopted";
    }
  }

  // Batched so the event loop keeps turning. Signature written LAST: a crash
  // mid-wipe leaves it stale, so the next boot re-enters and the (idempotent)
  // wipe resumes.
  await nullEmbeddingsInBatches(db, "", []);
  try { db.exec("DROP TABLE IF EXISTS chunks_vec"); } catch {}
  setSig.run(SIGNATURE_KEY, sig);
  logger.warn(
    `[memory] Embedding provider changed (${stored ?? "untracked"} → ${sig}) — ` +
    `stale vectors wiped, re-embed scheduled`
  );
  return "wiped";
}

export function countChunksMissingEmbedding(db: InstanceType<typeof Database>): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NULL").get() as { n: number }
  ).n;
}

/**
 * Self-heal orphaned embeddings: NULL out any chunk whose stored vector has a
 * DIFFERENT dimension than the current provider. Those vectors are invisible to
 * search — cosineSimilarity scores mismatched-length vectors 0 (see utils.ts),
 * so the chunk silently never comes back from memory_search even though its
 * text is right there on disk. The signature wipe in reconcileEmbeddingSignature
 * catches the clean provider-change case, but chunks falsely "adopted" from a
 * pre-signature corpus, or survivors of a partial wipe, keep a stale-dimension
 * vector. NULLing them here makes reembedMissingChunks rebuild them under the
 * current provider — so a model change can never leave content unsearchable.
 *
 * Uses json_array_length to read the stored JSON vector's length in SQL without
 * parsing every embedding in JS. Returns how many were healed. Live 2026-06-12:
 * an instruction in 2026-04-07.md was unfindable for exactly this reason.
 */
export async function nullDimensionMismatchedEmbeddings(
  db: InstanceType<typeof Database>,
  provider: EmbeddingProvider
): Promise<number> {
  try {
    return await nullEmbeddingsInBatches(
      db,
      " AND json_array_length(embedding) != ?",
      [provider.dimensions]
    );
  } catch {
    // json_array_length unavailable, or a non-JSON embedding — leave it for the
    // signature wipe path rather than risk nulling a valid vector.
    return 0;
  }
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
