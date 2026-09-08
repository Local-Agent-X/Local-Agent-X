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
import { restorePublishedCertifications } from "./certification-runner.js";
import type { LocalModel, LocalRuntimeInfo } from "./types.js";
import { classifyModel, maxToolsForTier, type ModelTier } from "../model-tiers.js";
import { getToolsVerified, hasNoTools } from "../providers/model-capabilities-store.js";
import { isLocalModelQualificationBoot } from "../qualification-boot.js";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface LocalModelCapabilityProfile {
  runtimeId: string | null;
  baseURL: string;
  model: string;
  tier: ModelTier;
  maxTools: number;
  contextWindow: number | null;
  tools: {
    advertised: boolean | null;
    verified: boolean | null;
    rejectsTools: boolean;
  };
}

/** Display-path staleness bound — same spirit as ollama-cloud's 60s TTL. */
const STALE_AFTER_MS = 60_000;

let cache: LocalRuntimeInfo[] | null = null;
let refreshedAt = 0;

// ── Change notification (mirror seam) ──────────────────────────────────────
//
// The egress worker thread (browser/egress-worker.ts) cannot see this module's
// cache — worker_threads get their own module instances — so its host mirrors
// the discovered-runtime set to it (the loopback-port egress carve-out reads
// this cache via security-config.ts localRuntimeLoopbackPorts). Every cache
// replacement notifies with the post-update snapshot (null = invalidated).
type LocalRuntimesChangeListener = (runtimes: readonly LocalRuntimeInfo[] | null) => void;
const runtimeListeners = new Set<LocalRuntimesChangeListener>();

/**
 * Subscribe to discovered-runtime cache changes. Replays the current snapshot
 * synchronously on subscribe (so a late subscriber — e.g. a restarted
 * egress-worker mirror — starts from the full current state), then fires after
 * every cache replacement. Returns an unsubscribe.
 */
export function subscribeLocalRuntimeChanges(cb: LocalRuntimesChangeListener): () => void {
  runtimeListeners.add(cb);
  cb(cache);
  return () => { runtimeListeners.delete(cb); };
}

function notifyLocalRuntimesChanged(): void {
  for (const cb of runtimeListeners) cb(cache);
}
let inflight: Promise<LocalRuntimeInfo[]> | null = null;
let restoreEpoch = 0;
let pendingRestore: { runtimes: LocalRuntimeInfo[]; epoch: number } | null = null;
let restoreWorker: Promise<void> | null = null;
let restoredSnapshot: LocalRuntimeInfo[] | null = null;

function scheduleCertificationRestore(runtimes: LocalRuntimeInfo[]): void {
  pendingRestore = { runtimes, epoch: restoreEpoch };
  if (restoreWorker) return;
  restoreWorker = (async () => {
    while (pendingRestore) {
      const job = pendingRestore;
      pendingRestore = null;
      try {
        await restorePublishedCertifications(job.runtimes, restoredSnapshot);
        if (job.epoch === restoreEpoch) restoredSnapshot = job.runtimes;
      } catch {
        if (job.epoch === restoreEpoch) restoredSnapshot = null;
      }
    }
  })().finally(() => { restoreWorker = null; });
}

/** Re-sweep and replace the cache. Coalesces concurrent callers. */
export async function refreshLocalRuntimes(): Promise<LocalRuntimeInfo[]> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      let found = await discoverLocalRuntimes(candidateEndpoints());
      // LM Studio app running with its API server toggled off is invisible
      // to the sweep; flip the server on (gated + throttled inside) and
      // re-sweep once so its models land in THIS refresh, not the next.
      if (!isLocalModelQualificationBoot() && await maybeAutostartLmStudio(found)) {
        found = await discoverLocalRuntimes(candidateEndpoints());
      }
      cache = found;
      refreshedAt = Date.now();
      notifyLocalRuntimesChanged();
      scheduleCertificationRestore(found);
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

/**
 * Deterministic capability snapshot for one local endpoint/model pair.
 * Derives from the discovery cache, canonical tier classifier, and persistent
 * capability store on every read; it owns no facts and cannot drift from them.
 */
export function getLocalModelCapabilityProfile(
  chatBaseUrl: string,
  model: string,
): LocalModelCapabilityProfile {
  const runtime = cache?.find((r) => r.chatBaseUrl === chatBaseUrl) ?? null;
  const localModel = runtime?.models.find((candidate) => candidate.id === model) ?? null;
  const tier = classifyModel(model);
  return {
    runtimeId: runtime?.id ?? null,
    baseURL: chatBaseUrl,
    model,
    tier,
    maxTools: maxToolsForTier(tier),
    contextWindow: localModel?.contextWindow ?? null,
    tools: {
      advertised: localModel?.tools ?? null,
      verified: getToolsVerified(chatBaseUrl, model)?.ok ?? null,
      rejectsTools: hasNoTools(chatBaseUrl, model),
    },
  };
}

/**
 * Re-probe ONE model's window when discovery recorded it as unknown.
 *
 * listModels reports contextWindow: null and probeModel fills it in — but on
 * Ollama the real served window only exists in /api/ps once the model is
 * LOADED, and a model is usually not loaded when the sweep runs. The null was
 * then frozen for the life of the cache entry: nothing re-probes a model whose
 * window is unknown, so callers fell back to the 8,192 floor for the whole
 * session while the model was actually serving 65,536 (observed 2026-09-08,
 * qwen3.6:27b — the UI read "246% context 20K / 8K"). It corrected only if an
 * unrelated sweep happened to land while the model was loaded, which is a race,
 * not a mechanism.
 *
 * Cheap and self-limiting: only fires while the window is unknown, coalesces
 * concurrent callers per model, and never overwrites a window we already know.
 */
const reprobeInflight = new Map<string, Promise<number | null>>();

export async function reprobeLocalModelWindow(
  chatBaseUrl: string,
  model: string,
): Promise<number | null> {
  const known = getLocalModel(chatBaseUrl, model);
  if (!known) return null;
  if (known.contextWindow !== null) return known.contextWindow;

  const key = `${chatBaseUrl}|${model}`;
  const existing = reprobeInflight.get(key);
  if (existing) return existing;

  const runtime = cache?.find((r) => r.chatBaseUrl === chatBaseUrl) ?? null;
  if (!runtime) return null;

  const run = (async (): Promise<number | null> => {
    const { LOCAL_RUNTIME_PROBES } = await import("./probes.js");
    const probe = LOCAL_RUNTIME_PROBES.find((p) => p.kind === runtime.kind);
    if (!probe) return null;
    let probed: Partial<LocalModel>;
    try {
      probed = await probe.probeModel(runtime.endpoint, model);
    } catch {
      return null;
    }
    const window = probed.contextWindow ?? null;
    if (window === null) return null;
    // Merge into the live entry rather than replacing the cache: a concurrent
    // full refresh must win, and every other field stays as discovery left it.
    const entry = cache?.find((r) => r.chatBaseUrl === chatBaseUrl)?.models.find((m) => m.id === model);
    if (entry && entry.contextWindow === null) {
      entry.contextWindow = window;
      if (probed.tools !== undefined && entry.tools === null) entry.tools = probed.tools;
      notifyLocalRuntimesChanged();
    }
    return window;
  })().finally(() => { reprobeInflight.delete(key); });

  reprobeInflight.set(key, run);
  return run;
}

/** Test seam + settings-change hook: drop the cache. */
export function invalidateLocalRuntimes(): void {
  cache = null;
  refreshedAt = 0;
  restoreEpoch += 1;
  pendingRestore = null;
  restoredSnapshot = null;
  notifyLocalRuntimesChanged();
}

export function restoreProjectedLocalRuntime(path: string): void {
  if (!isAbsolute(path)) throw new Error("projected local runtime path must be absolute");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    throw new Error("projected local runtime must be a bounded regular file");
  }
  const runtime = parseProjectedRuntime(JSON.parse(readFileSync(path, "utf8")));
  cache = [runtime];
  refreshedAt = Date.now();
  notifyLocalRuntimesChanged();
}

function parseProjectedRuntime(value: unknown): LocalRuntimeInfo {
  const runtime = value as Partial<LocalRuntimeInfo> | null;
  if (!runtime || !["ollama", "openai-compat"].includes(runtime.kind ?? "")
    || typeof runtime.id !== "string" || !runtime.id
    || typeof runtime.label !== "string" || !runtime.label
    || !runtime.endpoint || !["auto", "manual"].includes(runtime.endpoint.origin)
    || typeof runtime.endpoint.baseUrl !== "string"
    || typeof runtime.chatBaseUrl !== "string" || !Array.isArray(runtime.models)
    || runtime.models.length > 10_000 || !Number.isFinite(runtime.refreshedAt)
    || runtime.models.some(model => !model || typeof model.id !== "string" || !model.id
      || (model.contextWindow !== null && (!Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1))
      || (model.tools !== null && typeof model.tools !== "boolean"))) {
    throw new Error("projected local runtime is invalid");
  }
  return runtime as LocalRuntimeInfo;
}
