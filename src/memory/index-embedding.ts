import type Database from "better-sqlite3";
import type { Chunk, EmbeddingProvider, MemoryConfig } from "./types.js";
import { sleep } from "./utils.js";

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
    console.log(
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
      console.warn(`[memory] Embedding total timeout exceeded (${TOTAL_TIMEOUT_MS / 1000}s)`);
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
      console.warn(
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

  console.warn(
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

  console.log(`[memory] Pruned ${toDelete} stale embedding cache entries`);
}
