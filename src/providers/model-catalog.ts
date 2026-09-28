/**
 * Runtime model catalogs for the key-based cloud providers.
 *
 * The registry's static `models` list is what LAX ships; the provider's own
 * list-models endpoint is what the provider serves TODAY. When the user has a
 * key, the picker shows both: the curated list first, then anything the
 * provider added since this build (a new release appears in the picker without
 * a LAX release). The static list is the fallback — no key, no network, or an
 * endpoint that fails leaves the picker exactly as it was.
 *
 * Same shape as the Ollama Turbo catalog (ollama-cloud.ts): a per-provider
 * cache warmed at boot and on a key save (bootstrap-services.ts), re-read by
 * the providers route from cache only — never a network round-trip on the
 * provider-list path — and refreshed in the background when stale.
 *
 * Only the endpoints' model ids are used. Windows and prices stay in their
 * reviewed tables: a catalog-only model sizes by lookupContextWindow's family
 * heuristic and bills at the flagged fallback rate ("≈ est.").
 */
import { getRuntimeConfig } from "../config.js";
import { resolveCredential } from "../auth/resolve.js";
import { API_BASE as ANTHROPIC_API_BASE } from "../anthropic-client/request.js";
import { isLocalOnlyMode } from "../local-only-policy.js";
import { createLogger } from "../logger.js";
import type { SecretsStore } from "../secrets.js";
import { getSetting } from "../settings.js";
import type { ProviderId } from "./provider-ids.js";
import { PROVIDERS, chatModelsFor, isHttpProvider, resolveBaseURL } from "./registry.js";

const logger = createLogger("providers.model-catalog");

/** Providers with a key and a list-models endpoint. The subscription entries
 *  (anthropic, codex, xai OAuth) and the discovered catalogs (local,
 *  ollama-cloud) are not here: their lists come from elsewhere. */
export const CATALOG_PROVIDERS: readonly ProviderId[] = ["anthropic-api", "openai", "gemini", "xai", "cerebras", "custom"];

export const CATALOG_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_PAGES = 5;

export interface CatalogState {
  models: string[];
  refreshedAt: number;
  error?: string;
}

const cache = new Map<ProviderId, CatalogState>();
const inflight = new Map<ProviderId, Promise<CatalogState>>();

// ── What counts as a chat model, per provider ──────────────────────────────
// The endpoints list everything the account can call — embeddings, TTS,
// image, realtime, dated snapshots. The picker wants chat ids.

const OPENAI_CHAT = /^(gpt-[4-9]|o[1-9]|chatgpt-)/;
const OPENAI_NOT_CHAT = /audio|realtime|tts|transcri|search|image|embedding|moderation|instruct|codex|-\d{4}-\d{2}-\d{2}$|-\d{4}$/;
const GEMINI_NOT_CHAT = /tts|image|embedding|live|audio|computer-use|robotics|-\d{2}-\d{2}$/;
const XAI_NOT_CHAT = /image|vision/;
const GENERIC_NOT_CHAT = /embed|rerank|whisper|tts/i;

export function isCatalogChatModel(provider: ProviderId, id: string): boolean {
  switch (provider) {
    case "anthropic-api": return id.startsWith("claude-");
    case "openai": return OPENAI_CHAT.test(id) && !OPENAI_NOT_CHAT.test(id);
    case "gemini": return id.startsWith("gemini-") && !GEMINI_NOT_CHAT.test(id);
    case "xai": return id.startsWith("grok-") && !XAI_NOT_CHAT.test(id);
    default: return !GENERIC_NOT_CHAT.test(id);
  }
}

/** The curated list first (its order is deliberate), then what the provider
 *  serves beyond it, sorted. Nothing curated is ever dropped by a catalog. */
export function mergeCatalog(curated: readonly string[], catalog: readonly string[]): string[] {
  const have = new Set(curated);
  const extra = [...new Set(catalog.filter((id) => !have.has(id)))].sort();
  return [...curated, ...extra];
}

// ── Endpoint readers: each returns raw ids; filtering happens once, above ──

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const ids = (list: unknown): string[] =>
  Array.isArray(list) ? list.map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : undefined)).filter((id): id is string => typeof id === "string" && id.length > 0) : [];

/** GET /v1/models, paginated (default page is 20). */
async function listAnthropic(key: string): Promise<string[]> {
  const out: string[] = [];
  let after = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await getJson(
      `${ANTHROPIC_API_BASE}/v1/models?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ""}`,
      { "x-api-key": key, "anthropic-version": "2023-06-01" },
    ) as { data?: unknown; has_more?: boolean; last_id?: string };
    out.push(...ids(data.data));
    if (!data.has_more || !data.last_id) break;
    after = data.last_id;
  }
  return out;
}

/** GET {base}/models — the OpenAI wire shape (OpenAI, Cerebras, custom, xAI). */
async function listOpenAIShape(baseURL: string, key: string): Promise<string[]> {
  const data = await getJson(`${baseURL.replace(/\/+$/, "")}/models`, { Authorization: `Bearer ${key}` }) as { data?: unknown };
  return ids(data.data);
}

/** xAI lists language models on their own endpoint; the OpenAI-shape list is
 *  the fallback (both under api.x.ai/v1). */
async function listXai(baseURL: string, key: string): Promise<string[]> {
  try {
    const data = await getJson(`${baseURL.replace(/\/+$/, "")}/language-models`, { Authorization: `Bearer ${key}` }) as { models?: unknown };
    const found = ids(data.models);
    if (found.length > 0) return found;
  } catch (e) {
    logger.debug(`xai /language-models unavailable (${(e as Error).message}); falling back to /models`);
  }
  return listOpenAIShape(baseURL, key);
}

/** models.list, paginated; only models that can generateContent are chat. */
async function listGemini(key: string): Promise<string[]> {
  const out: string[] = [];
  let token = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await getJson(
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`,
      { "x-goog-api-key": key },
    ) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>; nextPageToken?: string };
    for (const m of data.models ?? []) {
      if (typeof m.name !== "string" || !m.supportedGenerationMethods?.includes("generateContent")) continue;
      out.push(m.name.replace(/^models\//, ""));
    }
    if (!data.nextPageToken) break;
    token = data.nextPageToken;
  }
  return out;
}

async function listFor(provider: ProviderId, key: string): Promise<string[]> {
  if (provider === "anthropic-api") return listAnthropic(key);
  if (provider === "gemini") return listGemini(key);
  const meta = PROVIDERS[provider];
  const baseURL = isHttpProvider(meta)
    ? resolveBaseURL(provider, { ollamaUrl: getRuntimeConfig().ollamaUrl, customBaseURL: getSetting<string>("customBaseUrl") || undefined })
    : null;
  if (!baseURL) throw new Error("no base URL configured");
  return provider === "xai" ? listXai(baseURL, key) : listOpenAIShape(baseURL, key);
}

// ── Cache ───────────────────────────────────────────────────────────────────

export function catalogStale(provider: ProviderId): boolean {
  const state = cache.get(provider);
  return !state || Date.now() - state.refreshedAt > CATALOG_TTL_MS;
}

/** Stale-tolerant ids for the DISPLAY path — whatever is cached, never a fetch. */
export function cachedCatalogModels(provider: ProviderId): string[] {
  return cache.get(provider)?.models ?? [];
}

/** The picker's models for a provider: the curated chat list plus what the
 *  provider's catalog adds. */
export function pickerModelsFor(provider: ProviderId): string[] {
  return mergeCatalog(chatModelsFor(provider), cachedCatalogModels(provider));
}

export function invalidateProviderCatalog(provider: ProviderId): void {
  cache.delete(provider);
}

/**
 * Fetch the provider's catalog and cache it. Never throws: a failure caches
 * an empty list with the error (so the picker falls back to the static list)
 * and is retried after the TTL. Concurrent calls share one request.
 */
export function refreshProviderCatalog(provider: ProviderId): Promise<CatalogState> {
  const running = inflight.get(provider);
  if (running) return running;
  const p = (async (): Promise<CatalogState> => {
    const failed = (error: string): CatalogState => {
      const state = { models: [], refreshedAt: Date.now(), error };
      cache.set(provider, state);
      return state;
    };
    if (isLocalOnlyMode() || !CATALOG_PROVIDERS.includes(provider)) return failed("catalog not available");
    try {
      const credential = await resolveCredential(provider, {
        configOpenAIKey: provider === "openai" ? getRuntimeConfig().openaiApiKey : undefined,
      });
      if (!credential) return failed("no credential");
      const raw = await listFor(provider, credential.credential);
      const models = raw.filter((id) => isCatalogChatModel(provider, id));
      const state = { models, refreshedAt: Date.now() };
      cache.set(provider, state);
      const extra = models.filter((id) => !PROVIDERS[provider].models.includes(id));
      logger.info(`${provider}: ${models.length} chat models listed by the provider, ${extra.length} beyond the shipped list${extra.length ? ` (${extra.join(", ")})` : ""}`);
      return state;
    } catch (e) {
      const message = (e as Error).message;
      logger.warn(`${provider}: model list unavailable (${message}); the picker shows the shipped list`);
      return failed(message);
    } finally {
      inflight.delete(provider);
    }
  })();
  inflight.set(provider, p);
  return p;
}

/** Refresh every credentialed catalog provider now, and again whenever a key
 *  is saved or removed (a saved key shows its models within seconds, a removed
 *  one stops listing them). Returns the unsubscribe for the key listener. */
export function warmProviderCatalogs(secretsStore: SecretsStore): () => void {
  const warm = () => {
    for (const provider of CATALOG_PROVIDERS) {
      if (!PROVIDERS[provider].auth.hasCredential({ secretsStore, configOpenAIKey: getRuntimeConfig().openaiApiKey })) continue;
      if (catalogStale(provider)) void refreshProviderCatalog(provider);
    }
  };
  warm();
  return secretsStore.onAvailabilityChange(({ name, type }) => {
    for (const provider of CATALOG_PROVIDERS) {
      if (PROVIDERS[provider].envKey !== name) continue;
      invalidateProviderCatalog(provider);
      if (type === "available") void refreshProviderCatalog(provider);
    }
  });
}

/** Test seam. */
export function resetProviderCatalogs(): void {
  cache.clear();
  inflight.clear();
}
