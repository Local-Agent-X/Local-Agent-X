/**
 * Module cache of discovered local runtimes + sync getters for hot paths.
 *
 * Mirrors ollama-cloud.ts's display-cache discipline: the providers-list
 * route and per-turn lookups read the cache synchronously and NEVER block
 * on a network sweep; refreshLocalRuntimes() is fired by bootstrap at
 * startup and by routes on cold/stale hits.
 */
import { candidateEndpoints } from "./endpoints.js";
import { discoverLocalRuntimes } from "./discovery.js";
import { maybeAutostartLmStudio } from "./lmstudio-autostart.js";
import type { LocalModel, LocalRuntimeInfo } from "./types.js";

/** Display-path staleness bound — same spirit as ollama-cloud's 60s TTL. */
const STALE_AFTER_MS = 60_000;

let cache: LocalRuntimeInfo[] | null = null;
let refreshedAt = 0;
let inflight: Promise<LocalRuntimeInfo[]> | null = null;

/** Re-sweep and replace the cache. Coalesces concurrent callers. */
export async function refreshLocalRuntimes(): Promise<LocalRuntimeInfo[]> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      let found = await discoverLocalRuntimes(candidateEndpoints());
      // LM Studio app running with its API server toggled off is invisible
      // to the sweep; flip the server on (gated + throttled inside) and
      // re-sweep once so its models land in THIS refresh, not the next.
      if (await maybeAutostartLmStudio(found)) {
        found = await discoverLocalRuntimes(candidateEndpoints());
      }
      cache = found;
      refreshedAt = Date.now();
      return found;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Sync snapshot for display paths. null = never populated (fire a refresh). */
export function getLocalRuntimes(): LocalRuntimeInfo[] | null {
  return cache;
}

export function localRuntimesStale(): boolean {
  return cache === null || Date.now() - refreshedAt > STALE_AFTER_MS;
}

export function getLocalRuntimeById(id: string): LocalRuntimeInfo | null {
  return cache?.find((r) => r.id === id) ?? null;
}

/** Find the runtime currently serving `model`, preferring an exact id. */
export function getRuntimeForModel(model: string): LocalRuntimeInfo | null {
  return cache?.find((r) => r.models.some((m) => m.id === model)) ?? null;
}

export function getLocalModel(chatBaseUrl: string, model: string): LocalModel | null {
  const rt = cache?.find((r) => r.chatBaseUrl === chatBaseUrl);
  return rt?.models.find((m) => m.id === model) ?? null;
}

/**
 * The REAL context window for a local model, or null when unknown.
 * Callers must fall through to their own defaults on null — this module
 * never substitutes an optimistic guess.
 */
export function getLocalContextWindow(chatBaseUrl: string, model: string): number | null {
  return getLocalModel(chatBaseUrl, model)?.contextWindow ?? null;
}

/** Test seam + settings-change hook: drop the cache. */
export function invalidateLocalRuntimes(): void {
  cache = null;
  refreshedAt = 0;
}
