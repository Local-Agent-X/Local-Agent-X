/**
 * Runtime model catalogs for the key-based cloud providers.
 *
 * The registry's static `models` list is what LAX ships; the provider's own
 * list-models endpoint is what the provider serves TODAY. When the user has a
 * key, the picker shows what the provider serves: the curated list first (minus
 * anything a complete catalog no longer lists — a retired model disappears
 * from the picker without a LAX release), then anything the provider added
 * since this build. The static list is the fallback — no key, no network, an
 * endpoint that fails or a page that could not be read to the end leaves the
 * picker exactly as it was, nothing hidden.
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
  /** The fetch succeeded, every page was read and at least one chat model came
   *  back: `models` is the provider's whole lineup, so a shipped model absent
   *  from it is hidden. False on a failure or a page cap — nothing is hidden
   *  on a list that might be short. */
  complete: boolean;
  error?: string;
}

const cache = new Map<ProviderId, CatalogState>();
const inflight = new Map<ProviderId, Promise<CatalogState>>();
const hiddenLogged = new Map<ProviderId, string>();

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
 *  serves beyond it, sorted. A complete catalog also drops the curated ids it
 *  no longer lists; an incomplete one drops nothing. */
export function mergeCatalog(curated: readonly string[], catalog: readonly string[], complete = false): string[] {
  const have = new Set(curated);
  const listed = new Set(catalog);
  const kept = complete ? curated.filter((id) => listed.has(id)) : [...curated];
  const extra = [...listed].filter((id) => !have.has(id)).sort();
  return [...kept, ...extra];
}

// ── Endpoint readers: each returns raw ids; filtering happens once, above ──

interface Listing { ids: string[]; complete: boolean }

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const ids = (list: unknown): string[] =>
  Array.isArray(list) ? list.map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : undefined)).filter((id): id is string => typeof id === "string" && id.length > 0) : [];

/** GET /v1/models, paginated (default page is 20). */
async function listAnthropic(key: string): Promise<Listing> {
  const out: string[] = [];
  let after = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await getJson(
      `${ANTHROPIC_API_BASE}/v1/models?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ""}`,
      { "x-api-key": key, "anthropic-version": "2023-06-01" },
    ) as { data?: unknown; has_more?: boolean; last_id?: string };
    out.push(...ids(data.data));
    if (!data.has_more || !data.last_id) return { ids: out, complete: true };
    after = data.last_id;
  }
  return { ids: out, complete: false };
}

/** GET {base}/models — the OpenAI wire shape (OpenAI, Cerebras, custom, xAI). */
async function listOpenAIShape(baseURL: string, key: string): Promise<Listing> {
  const data = await getJson(`${baseURL.replace(/\/+$/, "")}/models`, { Authorization: `Bearer ${key}` }) as { data?: unknown };
  return { ids: ids(data.data), complete: true };
}

/** xAI lists language models on their own endpoint; the OpenAI-shape list is
 *  the fallback (both under api.x.ai/v1). */
async function listXai(baseURL: string, key: string): Promise<Listing> {
  try {
    const data = await getJson(`${baseURL.replace(/\/+$/, "")}/language-models`, { Authorization: `Bearer ${key}` }) as { models?: unknown };
    const found = ids(data.models);
    if (found.length > 0) return { ids: found, complete: true };
  } catch (e) {
    logger.debug(`xai /language-models unavailable (${(e as Error).message}); falling back to /models`);
  }
  return listOpenAIShape(baseURL, key);
}

/** models.list, paginated; only models that can generateContent are chat. */
async function listGemini(key: string): Promise<Listing> {
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
    if (!data.nextPageToken) return { ids: out, complete: true };
    token = data.nextPageToken;
  }
  return { ids: out, complete: false };
}

async function listFor(provider: ProviderId, key: string): Promise<Listing> {
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

/** The picker's models for a provider: the curated chat list, minus what a
 *  complete catalog no longer lists, plus what it adds. */
export function pickerModelsFor(provider: ProviderId): string[] {
  const state = cache.get(provider);
  return mergeCatalog(chatModelsFor(provider), state?.models ?? [], state?.complete ?? false);
}

/** Shipped chat models a complete catalog no longer lists — hidden from the
 *  picker, still in the registry. Empty without a complete catalog. */
export function hiddenShippedModels(provider: ProviderId): string[] {
  const state = cache.get(provider);
  if (!state?.complete) return [];
  const listed = new Set(state.models);
  return chatModelsFor(provider).filter((id) => !listed.has(id));
}

/**
 * Whether a model id can run on a provider — the request path's check for a
 * saved or pinned model. Shipped ids always can, hidden or not: a chat that
 * was running on a model the catalog dropped since finishes on it. Beyond the
 * shipped list, a complete catalog is the authority; without one (no key, a
 * failed fetch, a provider with no list API) the id is trusted, because the
 * only alternative is refusing a model that may well work. `custom` lists a
 * placeholder id and the user types the real one, so it always resolves.
 */
export function providerServesModel(provider: ProviderId, model: string): boolean {
  const shipped = PROVIDERS[provider].models;
  if (provider === "custom" || shipped.length === 0 || shipped.includes(model)) return true;
  const state = cache.get(provider);
  if (state?.complete) return state.models.includes(model);
  return CATALOG_PROVIDERS.includes(provider);
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
      const state = { models: [], refreshedAt: Date.now(), complete: false, error };
      cache.set(provider, state);
      return state;
    };
    if (isLocalOnlyMode() || !CATALOG_PROVIDERS.includes(provider)) return failed("catalog not available");
    try {
      const credential = await resolveCredential(provider, {
        configOpenAIKey: provider === "openai" ? getRuntimeConfig().openaiApiKey : undefined,
      });
      if (!credential) return failed("no credential");
      const listing = await listFor(provider, credential.credential);
      const models = listing.ids.filter((id) => isCatalogChatModel(provider, id));
      const state = { models, refreshedAt: Date.now(), complete: listing.complete && models.length > 0 };
      cache.set(provider, state);
      const extra = models.filter((id) => !PROVIDERS[provider].models.includes(id));
      logger.info(`${provider}: ${models.length} chat models listed by the provider, ${extra.length} beyond the shipped list${extra.length ? ` (${extra.join(", ")})` : ""}`);
      const hidden = hiddenShippedModels(provider);
      if (hidden.length > 0 && hiddenLogged.get(provider) !== hidden.join(",")) {
        hiddenLogged.set(provider, hidden.join(","));
        logger.info(`${provider}: ${hidden.length} shipped models the provider no longer lists are hidden from the picker (${hidden.join(", ")})`);
      }
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
  hiddenLogged.clear();
}
