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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getRuntimeConfig } from "../config.js";
import { getEmbeddingProviderSingleton } from "../embedding-singleton.js";
import { createLogger } from "../logger.js";
import type { Protocol } from "../protocols.js";

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

function textOf(p: Protocol): string {
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

function saveCache(cache: EmbeddingCache): void {
  writeFileSync(embeddingsPath(), JSON.stringify(cache, null, 2), "utf-8");
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Ensure every protocol in `all` has a current embedding in the cache.
 *  Re-embeds entries whose text hash has changed. Returns the cache (which
 *  may have been mutated). */
async function refreshCache(all: Protocol[]): Promise<EmbeddingCache> {
  const provider = getEmbeddingProviderSingleton();
  if (!provider) return loadCache(); // soft-degrade — caller handles
  const cache = loadCache();
  let dirty = false;
  for (const p of all) {
    const text = textOf(p);
    const hash = hashText(text);
    const existing = cache[p.name];
    if (existing && existing.textHash === hash) continue;
    try {
      const vec = await provider.embed(text);
      cache[p.name] = { vec, textHash: hash };
      dirty = true;
    } catch (e) {
      logger.warn(`[dedup] embed failed for ${p.name}: ${(e as Error).message}`);
    }
  }
  if (dirty) {
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
    candidateVec = await provider.embed(textOf(candidate as Protocol));
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
