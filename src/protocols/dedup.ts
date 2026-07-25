/**
 * Embedding-based protocol dedup.
 *
 * On protocol_create / protocol_build: embed `name + description + triggers`,
 * compare against every existing protocol's embedding, and refuse to create a
 * near-duplicate. Catalog stays clean instead of accumulating "ChatGPT image
 * download", "Download from ChatGPT", "Save image from ChatGPT page" — three
 * separate entries that should be one.
 *
 * Storage: workspace/protocols/embeddings.json (sidecar to custom.json so it
 * syncs across machines the same way). Maps protocol name → vector + the text
 * that produced it (cheap rebuild check: if the text changes, the cached
 * vector is invalidated).
 *
 * Soft dependency on the embedding provider — if memory init didn't run or
 * the provider is degraded, dedup degrades to a no-op rather than blocking
 * protocol creation. Logged as a warning so the user knows.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getRuntimeConfig } from "../config.js";
import { atomicWriteFileSync } from "../util/json-store.js";
import { getEmbeddingProviderSingleton } from "../embedding-singleton.js";
import { createLogger } from "../logger.js";
import type { Protocol } from "../protocols/index.js";

const logger = createLogger("protocols.dedup");

/** Cosine-similarity threshold above which a new protocol is considered a
 *  duplicate. 0.85 empirically catches near-paraphrases ("Download from
 *  ChatGPT" vs "Save image from ChatGPT page") while letting genuinely
 *  different protocols through. Tunable per user via settings.json
 *  `protocolDedupThreshold` if it turns out 0.85 is too aggressive. */
const DEFAULT_THRESHOLD = 0.85;

interface EmbeddingCacheEntry {
  vec: number[];
  /** Hash of the embedded text — invalidate cache when the protocol's text changes. */
  textHash: string;
}

type EmbeddingCache = Record<string, EmbeddingCacheEntry>;

function embeddingsPath(): string {
  const cfg = getRuntimeConfig();
  const dir = resolve(cfg.workspace, "protocols");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "embeddings.json");
}

/** The exact text a protocol's dedup embedding is computed from. Exported so
 *  write paths can tell whether an edit invalidated the cached vector without
 *  re-deriving (and drifting from) this definition. */
export function dedupTextOf(p: Pick<Protocol, "name" | "description" | "triggers">): string {
  const triggers = (p.triggers || []).join(" | ");
  return `${p.name}\n${p.description}\n${triggers}`;
}

function hashText(s: string): string {
  // Tiny djb2 — collision risk is irrelevant because we use it only to detect
  // "did the source text change since we last embedded it", not for security.
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h.toString(36);
}

function loadCache(): EmbeddingCache {
  const p = embeddingsPath();
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return {}; }
}

/** Atomic so a half-written sidecar can never be observed: the background
 *  review fork embeds concurrently with foreground protocol writes, and a
 *  torn embeddings.json parses as `{}` — silently discarding every cached
 *  vector and forcing a full re-embed of the catalog. */
function saveCache(cache: EmbeddingCache): void {
  atomicWriteFileSync(embeddingsPath(), JSON.stringify(cache, null, 2));
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Ensure every protocol in `all` has a current embedding in the cache, and
 *  reconcile the cache against the live catalog. Returns the cache.
 *
 *  Two rules make this safe under concurrent writers, which the background
 *  review fork introduces:
 *
 *  1. Embed into a DELTA map, then re-read the cache after the awaits and
 *     apply the delta onto that fresh copy. Writing back a snapshot loaded
 *     before `await provider.embed(...)` would silently revert everything
 *     another writer did inside that window — including a dropEmbedding()
 *     that landed there, which resurrects the exact orphan it removed.
 *  2. Prune every key no live protocol claims. This is what makes the cache
 *     self-correcting rather than dependent on a drop and a refresh never
 *     overlapping: a rename leaves an entry under the old name that nothing
 *     would ever revisit, and embeddings.json is workspace-git-synced, so
 *     orphans accumulate across every machine forever. dropEmbedding() is now
 *     a fast path, not the only defence.
 *
 *  The read-modify-write at the end is await-free on purpose — within this
 *  process the event loop serializes it. */
async function refreshCache(all: Protocol[]): Promise<EmbeddingCache> {
  const provider = getEmbeddingProviderSingleton();
  if (!provider) return loadCache(); // soft-degrade — caller handles

  const seen = loadCache();
  const delta: EmbeddingCache = {};
  for (const p of all) {
    const text = dedupTextOf(p);
    const hash = hashText(text);
    const existing = seen[p.name];
    if (existing && existing.textHash === hash) continue;
    try {
      delta[p.name] = { vec: await provider.embed(text), textHash: hash };
    } catch (e) {
      logger.warn(`[dedup] embed failed for ${p.name}: ${(e as Error).message}`);
    }
  }

  // Resolve the authoritative name set BEFORE re-reading, so load → mutate →
  // save below contains no await. Read from the catalog rather than from the
  // caller's `all` so a caller that passes a subset can never wipe the cache.
  //
  // Bracket that read: EVERY tier degrades an I/O failure to "empty" (a git
  // merge-conflict blob in custom.json, an EBUSY readdir during a sync or AV
  // scan), and pruning against a partial catalog deletes vectors for
  // protocols that still exist. Skipping the prune costs one pass of orphan
  // retention; pruning on bad data costs a full re-embed of the catalog,
  // atomically written and git-synced to every machine. A `live.size === 0`
  // check would not do: the dangerous case is PARTIAL, where built-ins load
  // fine and only the custom tier failed.
  const { getAllProtocols } = await import("../protocols/index.js");
  const { catalogReadFailureCount } = await import("./loader.js");
  const failuresBefore = catalogReadFailureCount();
  const live = new Set(getAllProtocols().map((p) => p.name));
  const catalogComplete = catalogReadFailureCount() === failuresBefore;

  const cache = loadCache();
  Object.assign(cache, delta);
  let pruned = 0;
  if (catalogComplete) {
    for (const name of Object.keys(cache)) {
      if (!live.has(name)) { delete cache[name]; pruned += 1; }
    }
  } else {
    logger.warn(`[dedup] catalog read was partial — skipping embedding-cache prune`);
  }
  if (Object.keys(delta).length > 0 || pruned > 0) {
    try { saveCache(cache); } catch (e) { logger.warn(`[dedup] cache save failed: ${(e as Error).message}`); }
  }
  return cache;
}

export interface DuplicateMatch {
  name: string;
  similarity: number;
}

/**
 * Check if a candidate protocol is a near-duplicate of any existing one.
 * Returns the top match if similarity exceeds the threshold; null otherwise
 * (including when embeddings are unavailable — we never block on a soft dep).
 */
export async function findDuplicate(
  candidate: { name: string; description: string; triggers: string[] },
  existingProtocols: Protocol[],
  threshold = DEFAULT_THRESHOLD,
): Promise<DuplicateMatch | null> {
  const provider = getEmbeddingProviderSingleton();
  if (!provider) {
    logger.warn(`[dedup] embedding provider unavailable — dedup skipped`);
    return null;
  }

  // Make sure existing protocols' embeddings are in the cache. This is the
  // O(N) cost on the first ever call; subsequent calls hit cache.
  const cache = await refreshCache(existingProtocols);

  let candidateVec: number[];
  try {
    candidateVec = await provider.embed(dedupTextOf(candidate));
  } catch (e) {
    logger.warn(`[dedup] candidate embed failed: ${(e as Error).message} — skipped`);
    return null;
  }

  let bestName = "";
  let bestSim = 0;
  for (const p of existingProtocols) {
    if (p.name === candidate.name) continue; // editing self — not a dup
    const entry = cache[p.name];
    if (!entry) continue;
    const sim = cosine(candidateVec, entry.vec);
    if (sim > bestSim) { bestSim = sim; bestName = p.name; }
  }
  if (bestSim >= threshold) return { name: bestName, similarity: bestSim };
  return null;
}

/**
 * The dedup gate as the write paths actually use it: candidate vs. the whole
 * live catalog. Both the `protocol_create` tool and `authorProtocol()` call
 * this, so there is exactly one definition of "is this a near-duplicate" —
 * previously the check existed only inside the tool wrapper, which is why a
 * programmatic caller could create duplicates freely.
 *
 * `getAllProtocols` is imported lazily: protocols/index.ts imports builder.ts,
 * which is the other half of this pair, and a static import here would make
 * that a load-time cycle.
 */
export async function findCatalogDuplicate(
  candidate: { name: string; description: string; triggers: string[] },
  threshold?: number,
): Promise<DuplicateMatch | null> {
  const { getAllProtocols } = await import("../protocols/index.js");
  return findDuplicate(candidate, getAllProtocols(), threshold);
}

/** Drop an entry from the cache (call after protocol_delete). */
export function dropEmbedding(name: string): void {
  try {
    const cache = loadCache();
    if (cache[name]) {
      delete cache[name];
      saveCache(cache);
    }
  } catch { /* best-effort */ }
}
