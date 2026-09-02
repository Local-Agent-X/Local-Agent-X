/**
 * Provider signature reconciliation + vector-table lifecycle.
 *
 * chunks.embedding rows are only comparable to query vectors from the SAME
 * provider+model. Nothing used to record which provider wrote them, so a
 * config change (or a lost API key) silently degraded vector search to
 * garbage scores: same-dims model swaps produce plausible-but-wrong
 * similarities, different-dims swaps score 0 everywhere. The signature in
 * the meta table pins the vector space; on a real provider change we wipe
 * stale vectors and let reembedMissingChunks rebuild them in the background.
 */
import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "./types.js";

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

const SIGNATURE_KEY = "embedding_signature";

// Full-table UPDATEs over a large chunk corpus (~45k rows observed) used to
// run as one synchronous statement on the main event loop, starving every
// concurrent awaited boot phase (measured: setupVoiceWs inflated 17-21s).
const UPDATE_BATCH_ROWS = 4000;

export function yieldEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

// NULL chunk embeddings matching the AND-appended predicate, batched by rowid
// with an event-loop yield between batches. Each batch UPDATE is atomic; rows
// inserted after the bounds snapshot carry vectors from the CURRENT provider
// (callers set the provider before invoking) and are correctly left alone.
// shouldContinue is the attach path's swap-epoch probe (see
// attachEmbeddingProvider): once it reports false the pass stops before its
// next batch, so a superseded attach can never keep wiping under a regime the
// winner has already replaced.
async function nullEmbeddingsInBatches(
  db: InstanceType<typeof Database>,
  predicateSql: string,
  params: readonly unknown[],
  shouldContinue: () => boolean = () => true
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
    if (!shouldContinue()) break;
    const hi = Math.min(lo + UPDATE_BATCH_ROWS - 1, bounds.hi);
    changed += stmt.run(lo, hi, ...params).changes;
    await yieldEventLoop();
  }
  return changed;
}

export function embeddingSignature(p: EmbeddingProvider): string {
  return `${p.name}/${p.model}/${p.dimensions}`;
}

// "superseded": the attach was overtaken by a newer setEmbeddingProvider call
// mid-flight and halted before its irreversible tail writes. The caller's own
// staleness probe fires on the same epoch, so this verdict is never acted on.
export type SignatureVerdict = "match" | "adopted" | "wiped" | "degraded" | "superseded";

export async function reconcileEmbeddingSignature(
  db: InstanceType<typeof Database>,
  provider: EmbeddingProvider,
  shouldContinue: () => boolean = () => true
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
  await nullEmbeddingsInBatches(db, "", [], shouldContinue);
  // A superseded attach stops HERE, before the two irreversible tail writes:
  // dropping chunks_vec would orphan the winner's table (recreated next with
  // the loser's dims, its inserts silently swallowed), and writing the loser's
  // signature over the winner's forces a full paid re-embed at next boot.
  // Rows already NULLed stay NULL — the winner's kick re-embeds them under
  // its own regime.
  if (!shouldContinue()) return "superseded";
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
 * Measures the vector's length in SQL so we never parse every embedding in JS.
 * Returns how many were healed. Live 2026-06-12: an instruction in
 * 2026-04-07.md was unfindable for exactly this reason.
 *
 * BOTH encodings are covered. Blobs are 4 bytes per float32 component; legacy
 * JSON text rows still awaiting conversion keep the json_array_length test.
 * Testing only one would silently retire this self-heal for the other half of
 * the corpus while the background conversion drains (embedding-codec.ts).
 */
export async function nullDimensionMismatchedEmbeddings(
  db: InstanceType<typeof Database>,
  provider: EmbeddingProvider,
  shouldContinue: () => boolean = () => true
): Promise<number> {
  let healed = 0;
  healed += await nullEmbeddingsInBatches(
    db,
    " AND typeof(embedding) = 'blob' AND length(embedding) != ?",
    [provider.dimensions * 4],
    shouldContinue
  );
  try {
    healed += await nullEmbeddingsInBatches(
      db,
      " AND typeof(embedding) = 'text' AND json_array_length(embedding) != ?",
      [provider.dimensions],
      shouldContinue
    );
  } catch {
    // json_array_length unavailable, or a non-JSON text embedding — leave it
    // for the signature wipe path rather than risk nulling a valid vector.
  }
  return healed;
}

/**
 * Self-heal degraded-mode poison: NULL any chunk whose stored vector is
 * all-zero. A provider returns an all-zero vector as its degraded sentinel
 * (Ollama wedged mid-model-load, missing API key); if one gets persisted it
 * is correct-dimension and non-NULL, so neither the dimension self-heal nor
 * the missing-chunk backfill ever touches it — the chunk stays permanently
 * unsearchable (vector search scores a zero vector 0 against every query).
 * NULLing it hands the chunk to reembedMissingChunks, which rebuilds a real
 * vector once the provider recovers; until then the chunk is at least
 * keyword-searchable instead of silently invisible.
 *
 * Both encodings are tested, in SQL, so we never parse each vector in JS:
 *
 * - blob: an all-zero float32 vector is byte-identical to zeroblob(n), since
 *   +0.0f is four zero bytes. (A -0.0f sentinel would be 0x80000000 and slip
 *   through, but degraded providers emit +0.)
 * - text: an all-zero JSON vector ("[0,0,...,0]") is exactly the set of stored
 *   vectors containing no 1-9 digit — every real component carries a
 *   significant digit, and JSON.stringify renders the only other value, 0, as
 *   bare "0". GLOB is a text operator, so it must not be aimed at blobs.
 */
export async function nullZeroVectorEmbeddings(
  db: InstanceType<typeof Database>,
  shouldContinue: () => boolean = () => true
): Promise<number> {
  let healed = 0;
  healed += await nullEmbeddingsInBatches(
    db,
    " AND typeof(embedding) = 'blob' AND embedding = zeroblob(length(embedding))",
    [],
    shouldContinue
  );
  healed += await nullEmbeddingsInBatches(
    db,
    " AND typeof(embedding) = 'text' AND embedding NOT GLOB '*[1-9]*'",
    [],
    shouldContinue
  );
  return healed;
}

/**
 * Drop all-zero rows from the content-keyed embedding cache. cacheEmbedding
 * now refuses to write them, but rows persisted before that guard would be
 * served straight back by getCachedEmbedding — re-poisoning the very chunk
 * nullZeroVectorEmbeddings just cleared. One statement: the cache is
 * LRU-capped, so it stays small.
 */
export function purgeZeroVectorEmbeddingCache(
  db: InstanceType<typeof Database>
): number {
  try {
    return db
      .prepare(
        // Same two-encoding test as nullZeroVectorEmbeddings — see its comment.
        "DELETE FROM embedding_cache WHERE " +
        "(typeof(embedding) = 'blob' AND embedding = zeroblob(length(embedding))) OR " +
        "(typeof(embedding) = 'text' AND embedding NOT GLOB '*[1-9]*')"
      )
      .run().changes;
  } catch {
    return 0;
  }
}

/**
 * Provider-attach reconciliation — the boot path behind
 * MemoryIndex.setEmbeddingProvider. Async: the signature wipe and the
 * self-heal passes batch their full-table sqlite work and yield the event
 * loop, so boot-time callers no longer starve concurrent awaited phases
 * (measured 17-21s setupVoiceWs inflation).
 *
 * Beyond the clean provider-change wipe, chunks falsely adopted from a
 * pre-signature corpus (or survivors of a partial wipe) keep a
 * stale-DIMENSION vector that search silently scores 0 → unfindable. Those
 * are NULLed here so the caller's backfill rebuilds them under the current
 * provider — a model change can never permanently orphan content. Skipped
 * in the degraded local-fallback state: re-embedding a real provider's
 * corpus with TF-IDF would trade good vectors for junk.
 *
 * shouldContinue mirrors reembedMissingChunks' staleness probe: the caller
 * hands in its swap-epoch check (setEmbeddingProvider's `!swap.stale()`), and
 * once it reports false this attach halts at its next batch boundary. Without
 * it a superseded attach resumed after every interior await and kept wiping,
 * dropping chunks_vec and writing its signature under a regime the winner had
 * already replaced.
 */
export async function attachEmbeddingProvider(
  db: InstanceType<typeof Database>,
  provider: EmbeddingProvider,
  shouldContinue: () => boolean = () => true
): Promise<{ verdict: SignatureVerdict; hasVec: boolean }> {
  const verdict = await reconcileEmbeddingSignature(db, provider, shouldContinue);
  if (verdict === "superseded" || !shouldContinue()) {
    return { verdict: "superseded", hasVec: false };
  }
  const { hasVec } = initVectorTable(db, provider.dimensions);

  // All-zero sentinel vectors are invalid for EVERY provider, so heal them
  // regardless of verdict — even the local fallback is better off
  // keyword-searching a NULLed chunk than never returning a zero-vector one.
  // NULLed chunks re-embed on the next healthy backfill; the cache purge stops
  // getCachedEmbedding re-serving a stale zero into a chunk just cleared.
  const purged = purgeZeroVectorEmbeddingCache(db);
  const zeroed = await nullZeroVectorEmbeddings(db, shouldContinue);
  if (!shouldContinue()) return { verdict: "superseded", hasVec };
  if (zeroed > 0 || purged > 0) {
    logger.warn(
      `[memory] Self-heal: cleared ${zeroed} all-zero chunk vector(s) + ${purged} cache row(s) ` +
      `(degraded-mode embedding poison) — will re-embed under ${provider.name}/${provider.model} once healthy`,
    );
  }

  // Guarded hardest: a superseded attach's dim-heal ran with the LOSER's
  // dimensions, NULLing every vector the winner had just written or kept.
  if (verdict !== "degraded") {
    const healed = await nullDimensionMismatchedEmbeddings(db, provider, shouldContinue);
    if (!shouldContinue()) return { verdict: "superseded", hasVec };
    if (healed > 0) {
      logger.warn(
        `[memory] Self-heal: ${healed} chunk(s) had stale-dimension embeddings ` +
        `(orphaned by an embedding-model change) — re-embedding under ${provider.name}/${provider.model}`,
      );
    }
  }
  return { verdict, hasVec };
}
