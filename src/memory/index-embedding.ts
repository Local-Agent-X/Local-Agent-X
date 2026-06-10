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
      chunks[i].embedding = newEmbeddings[newIdx];
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

export function embeddingSignature(p: EmbeddingProvider): string {
  return `${p.name}/${p.model}/${p.dimensions}`;
}

export type SignatureVerdict = "match" | "adopted" | "wiped" | "degraded";

export function reconcileEmbeddingSignature(
  db: InstanceType<typeof Database>,
  provider: EmbeddingProvider
): SignatureVerdict {
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

  db.transaction(() => {
    db.prepare("UPDATE chunks SET embedding = NULL WHERE embedding IS NOT NULL").run();
    try { db.exec("DROP TABLE IF EXISTS chunks_vec"); } catch {}
    setSig.run(SIGNATURE_KEY, sig);
  })();
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
