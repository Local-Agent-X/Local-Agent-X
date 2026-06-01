/**
 * Ollama Cloud (Turbo) integration.
 *
 * Cloud Ollama is wire-compatible with local Ollama — same `/api/tags`
 * for model listing, same OpenAI-style `/v1/chat/completions` for chat.
 * The only differences are the URL and a Bearer token. So instead of a
 * second "ollama-cloud" provider in the picker (more code, more UI,
 * more user mental overhead), we treat it as the SAME `local` provider
 * with a remote endpoint configurable per-model.
 *
 * Flow:
 *   1. User adds OLLAMA_CLOUD_API_KEY to secrets.
 *   2. On the providers list endpoint, we fetch cloud `/api/tags` and
 *      merge cloud model names into the local Ollama dropdown.
 *   3. The cloud-model name set is cached in this module.
 *   4. At chat dispatch time, the canonical chat-runner consults
 *      `isCloudModel(name)` to decide whether the LocalOllamaAdapter
 *      should call the cloud URL with the cloud key, or the local URL
 *      without one.
 *
 * Conflict policy: if a model name exists both locally and in the cloud,
 * cloud wins (the user paid for it, expects it to be served). Future:
 * surface origin in the picker so the user can pick explicitly.
 */
import type { SecretsStore } from "./secrets.js";
import { isEmbeddingModel } from "./canonical-loop/model-capabilities.js";
import { createLogger } from "./logger.js";

const logger = createLogger("ollama-cloud");

const SECRET_KEY = "OLLAMA_CLOUD_API_KEY";
/** TTL for the in-memory cloud-model cache. Refreshed on /api/providers
 *  hits, but bounded so a settings change is reflected quickly without
 *  hammering the cloud `/api/tags` endpoint on every chat turn. */
const REFRESH_TTL_MS = 60_000;

interface CloudState {
  apiKey: string;
  baseURL: string;
  modelNames: Set<string>;
  refreshedAt: number;
}

let cached: CloudState | null = null;

function readApiKey(secretsStore: SecretsStore): string | null {
  try {
    if (!secretsStore.has(SECRET_KEY)) return null;
    const v = secretsStore.get(SECRET_KEY);
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Fetch cloud Ollama model names (with auth). Returns null if not
 * configured or unreachable. Updates the in-module cache.
 */
export async function refreshCloudOllama(
  secretsStore: SecretsStore,
  cloudUrl: string,
): Promise<{ models: string[]; reachable: boolean; error?: string }> {
  const apiKey = readApiKey(secretsStore);
  if (!apiKey) {
    cached = null;
    return { models: [], reachable: false, error: "OLLAMA_CLOUD_API_KEY not set" };
  }
  if (!cloudUrl) {
    cached = null;
    return { models: [], reachable: false, error: "ollamaCloudUrl not configured" };
  }
  // Strip trailing slash for clean concat.
  const base = cloudUrl.replace(/\/+$/, "");
  try {
    const r = await fetch(`${base}/api/tags`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) {
      cached = null;
      return { models: [], reachable: false, error: `cloud Ollama returned ${r.status}` };
    }
    const data = (await r.json()) as { models?: Array<{ name: string }> };
    const names = (data.models || [])
      .map(m => m.name)
      .filter(n => typeof n === "string" && n.length > 0)
      .filter(n => !isEmbeddingModel(n));
    cached = {
      apiKey,
      baseURL: base,
      modelNames: new Set(names),
      refreshedAt: Date.now(),
    };
    logger.info(`cached ${names.length} cloud Ollama models from ${base}`);
    return { models: names, reachable: true };
  } catch (e) {
    cached = null;
    return { models: [], reachable: false, error: (e as Error).message };
  }
}

/** Returns the cached cloud config + model set. Use when the cache is
 *  fresh enough — chat dispatch hot path, where we don't want to make
 *  an HTTP round-trip per turn. */
export function getCachedCloudOllama(): CloudState | null {
  if (!cached) return null;
  if (Date.now() - cached.refreshedAt > REFRESH_TTL_MS) {
    // Stale — caller should refresh. Return null so dispatch falls back
    // to local-only behaviour rather than using a stale cloud routing.
    cached = null;
    return null;
  }
  return cached;
}

/** Stale-tolerant cloud model names for the providers-list DISPLAY path.
 *  Unlike getCachedCloudOllama (fresh-or-null for dispatch), this returns
 *  whatever is cached so /api/providers never blocks on a network call —
 *  a background refresh keeps it current. */
export function getCachedCloudModels(): string[] {
  return cached ? [...cached.modelNames] : [];
}

// ── Local Ollama model cache ──────────────────────────────
// Mirrors the cloud pair above for the LOCAL Ollama endpoint. Exists so
// /api/providers can render the local model dropdown from cache instead of
// awaiting a live /api/tags round-trip on every cold-boot hit (the call that
// stacked 2-3s onto provider-list latency).

interface LocalState {
  reachable: boolean;
  models: string[];
  refreshedAt: number;
}

/** A raw `/api/tags` entry, unfiltered. Embedding models and chat models
 *  alike, with the size/timestamp fields callers like /api/models/local
 *  need. The chat-only `LocalState` cache is a derived view of this. */
export interface OllamaTag {
  name: string;
  size?: number;
  modified_at?: string;
}

let cachedLocal: LocalState | null = null;

/** THE one place that hits local Ollama's `/api/tags`. Returns the raw
 *  model list (nothing stripped) so each caller can apply its own view —
 *  chat-only, embeddings-only, or full with sizes. Always resolves;
 *  unreachable Ollama yields reachable:false + empty list, never throws. */
export async function fetchLocalOllamaTags(
  ollamaUrl: string,
): Promise<{ reachable: boolean; models: OllamaTag[] }> {
  const base = ollamaUrl.replace(/\/+$/, "");
  try {
    const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { reachable: false, models: [] };
    const data = (await r.json()) as { models?: OllamaTag[] };
    const models = (data.models || []).filter(m => typeof m?.name === "string" && m.name.length > 0);
    return { reachable: true, models };
  } catch {
    return { reachable: false, models: [] };
  }
}

/** Fetch local Ollama chat models (embeddings filtered out) and update the
 *  module cache. Derived view over {@link fetchLocalOllamaTags}. Always
 *  resolves — unreachable Ollama yields reachable:false with an empty list. */
export async function refreshLocalOllama(ollamaUrl: string): Promise<LocalState> {
  const { reachable, models } = await fetchLocalOllamaTags(ollamaUrl);
  cachedLocal = {
    reachable,
    models: models.map(m => m.name).filter(n => !isEmbeddingModel(n)),
    refreshedAt: Date.now(),
  };
  return cachedLocal;
}

/** Stale-tolerant local model cache for the providers-list DISPLAY path.
 *  Returns null only if never populated, so the handler can fire a
 *  background refresh on the first cold hit. */
export function getCachedLocalOllama(): LocalState | null {
  return cachedLocal;
}

/** True when the given model name is currently registered as a cloud
 *  model. Cheap lookup — used by chat-runner per turn. */
export function isCloudModel(modelName: string): boolean {
  return cached !== null && cached.modelNames.has(modelName);
}

/** Cloud baseURL + apiKey for the OpenAI-compat HTTP adapter, or null
 *  if cloud isn't configured / cached. The adapter expects the OpenAI-
 *  compat path; cloud Ollama serves it at `<base>/v1`, same as local. */
export function getCloudOllamaCallTarget(): { baseURL: string; apiKey: string } | null {
  if (!cached) return null;
  return { baseURL: `${cached.baseURL}/v1`, apiKey: cached.apiKey };
}

/** Force-clear the cache. Called by the settings route when the user
 *  changes the cloud key or URL so the next listing/chat reflects new
 *  config without waiting for the TTL to elapse. */
export function invalidateCloudOllamaCache(): void {
  cached = null;
}
