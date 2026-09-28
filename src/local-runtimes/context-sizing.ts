/**
 * Context sizing for local Ollama models — the one owner of "what num_ctx does
 * this model run at". Users never set it: LAX reads the model's architecture
 * and the machine's VRAM, picks the largest context that stays fully on the
 * GPU (context-sizing-core.ts), persists the decision per (model digest,
 * runtime version, GPU), and every consumer reads the same number:
 *
 *   ollama-native transport  -> options.num_ctx on every chat request
 *   cache.ts getLocalModel   -> the REPORTED window, so preflight, compaction,
 *                               the context meter and failover size against
 *                               the window the model actually runs at
 *   residency.ts             -> every warm and background dispatch, so no
 *                               background call ever resizes (= reloads) the
 *                               chat model (sched.go needsReload compares
 *                               num_ctx, ollama@16b4376a lines 1390-1438)
 *
 * Verification and contention handling live in context-sizing-adapt.ts.
 */
import { createHash } from "node:crypto";
import { createLogger } from "../logger.js";
import { isLoopbackUrl } from "../local-only-policy.js";
import {
  chooseContext, findPsRow, kvBytesPerToken, nativeContextLength, ollamaModelKey, parsePsRows,
  type GpuMemory,
} from "./context-sizing-core.js";
import { ContextSizingStore, type SizingRecord } from "./context-sizing-store.js";
import { machineGpuMemory } from "./gpu-memory.js";

const logger = createLogger("local-runtimes.context-sizing");

const HTTP_TIMEOUT_MS = 3_000;
/** How long a decision is trusted before its fingerprint is re-read. */
const REVALIDATE_MS = 5 * 60_000;
/** A background model LAX loads itself is loaded at no more than this. */
const BACKGROUND_NUM_CTX = 16_384;

export interface SizingDeps {
  fetchJson: (url: string, init?: RequestInit) => Promise<Record<string, unknown> | null>;
  gpu: () => Promise<GpuMemory | null>;
  store: ContextSizingStore;
  /** Other local models LAX keeps loaded next to the chat model. */
  backgroundModels: () => Promise<string[]>;
  /** The Ollama server's KV cache type for this model, when known. */
  kvCacheType: (model: string) => string | null;
  now: () => number;
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), ...init });
    if (!r.ok) return null;
    const data: unknown = await r.json();
    return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The classifier the user pinned and the Ollama embedder, when those are
 *  what LAX loads. An unpinned classifier runs on the chat model itself. */
async function settingsBackgroundModels(): Promise<string[]> {
  try {
    const { getSetting } = await import("../settings.js");
    const out: string[] = [];
    const classifier = (getSetting<string>("localClassifierModel") ?? "").trim();
    if (classifier) out.push(classifier);
    if (getSetting<string>("embeddingProvider") === "ollama") {
      out.push((getSetting<string>("embeddingModel") ?? "").trim() || "mxbai-embed-large");
    }
    return out;
  } catch {
    return []; // settings unreadable: size without background headroom this time
  }
}

async function profileKvCacheType(model: string): Promise<string | null> {
  const { resolveModelProfile } = await import("./model-profile.js");
  try { return resolveModelProfile(model)?.runtime.kvCacheQuant ?? null; } catch { return null; }
}

let kvTypeByModel = new Map<string, string | null>();
const defaultDeps = (): SizingDeps => ({
  fetchJson,
  gpu: machineGpuMemory,
  store: new ContextSizingStore(),
  backgroundModels: settingsBackgroundModels,
  kvCacheType: (model) => kvTypeByModel.get(model) ?? null,
  now: Date.now,
});

/** Runtime root with the host spelled one way, so config.ollamaUrl
 *  ("localhost") and the discovered runtime ("127.0.0.1") name one endpoint. */
export function sizingRoot(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  try {
    const u = new URL(trimmed);
    if (u.hostname === "localhost" || u.hostname === "[::1]") u.hostname = "127.0.0.1";
    return `${u.protocol}//${u.host}`;
  } catch {
    return trimmed;
  }
}

export function sizingKey(baseUrl: string, model: string): string {
  return `${sizingRoot(baseUrl)}|${ollamaModelKey(model)}`;
}

interface Entry { record: SizingRecord; checkedAt: number }
const entries = new Map<string, Entry>();
const diskChecked = new Set<string>();
const inflight = new Map<string, Promise<SizingRecord | null>>();
/** Temporary step-downs under contention, owned by context-sizing-adapt.ts. */
export const contentionOverrides = new Map<string, { numCtx: number; since: number; clearSince: number | null }>();

function entryFor(key: string, store?: ContextSizingStore): Entry | null {
  const hit = entries.get(key);
  if (hit || diskChecked.has(key)) return hit ?? null;
  // First look this process: the persisted decision, unvalidated. A warm that
  // fires before this turn's decide must still ask for the size chat will.
  diskChecked.add(key);
  const record = (store ?? new ContextSizingStore()).read(key);
  if (!record) return null;
  const entry = { record, checkedAt: 0 };
  entries.set(key, entry);
  return entry;
}

/** The num_ctx every request to `model` on `baseUrl` must carry, or undefined
 *  when LAX leaves the context to the runtime. Sync, for hot paths. */
export function appliedContext(baseUrl: string, model: string): number | undefined {
  const key = sizingKey(baseUrl, model);
  const override = contentionOverrides.get(key);
  if (override) return override.numCtx;
  return entryFor(key)?.record.numCtx ?? undefined;
}

/** The current decision, for display and for the adapt step. */
export function contextSizingRecord(baseUrl: string, model: string): SizingRecord | null {
  return entryFor(sizingKey(baseUrl, model))?.record ?? null;
}

export function saveContextSizingRecord(record: SizingRecord, store: ContextSizingStore = new ContextSizingStore()): void {
  entries.set(record.key, { record, checkedAt: entries.get(record.key)?.checkedAt ?? 0 });
  store.write(record);
}

function fingerprintOf(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

function tagRow(tags: Record<string, unknown> | null, model: string): { size: number | null; digest: string | null } | null {
  const models = Array.isArray(tags?.models) ? tags.models : [];
  const wanted = ollamaModelKey(model);
  for (const raw of models) {
    const row = raw as { name?: unknown; model?: unknown; size?: unknown; digest?: unknown };
    const name = typeof row?.name === "string" ? row.name : typeof row?.model === "string" ? row.model : "";
    if (ollamaModelKey(name) !== wanted) continue;
    return {
      size: typeof row.size === "number" && row.size > 0 ? row.size : null,
      digest: typeof row.digest === "string" ? row.digest : null,
    };
  }
  return null;
}

async function showInfo(deps: SizingDeps, root: string, model: string): Promise<Record<string, unknown> | null> {
  const show = await deps.fetchJson(`${root}/api/show`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }),
  });
  const info = show?.model_info;
  return info && typeof info === "object" ? (info as Record<string, unknown>) : null;
}

/** VRAM the background models will hold: what /api/ps measures for a loaded
 *  one, else weights + the KV of the background context they load at. */
async function headroomBytes(deps: SizingDeps, root: string, models: string[], tags: Record<string, unknown> | null): Promise<number> {
  if (models.length === 0) return 0;
  const rows = parsePsRows(await deps.fetchJson(`${root}/api/ps`)) ?? [];
  let total = 0;
  for (const model of models) {
    const loaded = findPsRow(rows, model);
    if (loaded) { total += loaded.sizeVramBytes; continue; }
    const size = tagRow(tags, model)?.size ?? 0;
    const info = size > 0 ? await showInfo(deps, root, model) : null;
    const kv = info ? kvBytesPerToken(info, deps.kvCacheType(model)) : null;
    const ctx = Math.min(info ? nativeContextLength(info) ?? BACKGROUND_NUM_CTX : BACKGROUND_NUM_CTX, BACKGROUND_NUM_CTX);
    total += kv !== null ? size + kv * ctx : Math.ceil(size * 1.5);
  }
  return total;
}

async function decide(root: string, model: string, deps: SizingDeps): Promise<SizingRecord | null> {
  const key = sizingKey(root, model);
  const [version, tags] = await Promise.all([
    deps.fetchJson(`${root}/api/version`), deps.fetchJson(`${root}/api/tags`),
  ]);
  const tag = tagRow(tags, model);
  if (!version || !tag) return null; // runtime unreachable or model not installed: nothing to size
  const runtimeVersion = typeof version.version === "string" ? version.version : null;
  const local = isLoopbackUrl(root);
  const gpu = local ? await deps.gpu() : null;
  const background = (await deps.backgroundModels())
    .filter((m) => ollamaModelKey(m) !== ollamaModelKey(model) && tagRow(tags, m) !== null)
    .sort();
  const kvType = deps.kvCacheType(model);
  const fingerprint = fingerprintOf([tag.digest, runtimeVersion, gpu?.name ?? null, gpu?.totalBytes ?? null, background, kvType]);
  const persistable = tag.digest !== null && runtimeVersion !== null;

  const stored = deps.store.read(key);
  if (stored && stored.fingerprint === fingerprint) return stored;

  const at = new Date(deps.now()).toISOString();
  const base = {
    key, fingerprint, nativeMax: null, weightsBytes: tag.size, kvBytesPerToken: null, headroomBytes: 0,
    budgetBytes: null, estimatedBytes: null, gpu, verification: "pending" as const, decidedAt: at,
  };
  if (!local) return { ...base, numCtx: null, reason: "remote_runtime" };
  const info = await showInfo(deps, root, model);
  const nativeMax = info ? nativeContextLength(info) : null;
  const kv = info ? kvBytesPerToken(info, kvType) : null;
  const headroom = gpu && nativeMax !== null && kv !== null ? await headroomBytes(deps, root, background, tags) : 0;
  const choice = chooseContext({ nativeMax, weightsBytes: tag.size, kvBytesPerToken: kv, gpu, headroomBytes: headroom });
  const record: SizingRecord = {
    ...base, nativeMax, kvBytesPerToken: kv, headroomBytes: headroom,
    numCtx: choice.numCtx, reason: choice.reason, budgetBytes: choice.budgetBytes, estimatedBytes: choice.estimatedBytes,
  };
  if (persistable) deps.store.write(record);
  await announce(record, stored, root, model);
  return record;
}

const gb = (n: number | null) => (n === null ? "?" : `${(n / 1e9).toFixed(1)} GB`);

async function announce(record: SizingRecord, previous: SizingRecord | null, root: string, model: string): Promise<void> {
  const size = record.numCtx === null ? `runtime default (${record.reason})` : `${record.numCtx.toLocaleString("en-US")} tokens (${record.reason})`;
  logger.info(`${model}: context ${size}; GPU ${record.gpu?.name ?? "unknown"} ${gb(record.gpu?.totalBytes ?? null)}, weights ${gb(record.weightsBytes)}, KV ${record.kvBytesPerToken ?? "?"} B/token, background headroom ${gb(record.headroomBytes)}, estimate ${gb(record.estimatedBytes)} of ${gb(record.budgetBytes)}`);
  if (!previous || previous.numCtx === record.numCtx) return;
  // A published certification is fingerprinted on the served window; the new
  // size will invalidate it once the model loads at it. Say so, not silently.
  try {
    const { getLocalRuntimes } = await import("./cache.js");
    const { hasPublishedCertification } = await import("./certification-runner.js");
    const runtime = getLocalRuntimes()?.find((r) => sizingRoot(r.endpoint.baseUrl) === root);
    const entry = runtime?.models.find((m) => ollamaModelKey(m.id) === ollamaModelKey(model));
    if (runtime && entry && hasPublishedCertification(runtime, entry)) {
      logger.warn(`${model}: context changes ${previous.numCtx ?? "default"} -> ${record.numCtx ?? "default"}; its published certification was taken at the old window and must be re-run once the model loads at the new one`);
    }
  } catch { /* the notice is advisory; the decision stands */ }
}

/**
 * Decide (or re-validate) the context for `model` on the Ollama runtime at
 * `baseUrl`. Waits at most `waitMs` — a slow runtime answers the NEXT turn,
 * never delays this one past that — and never throws.
 */
export async function ensureContextDecision(
  baseUrl: string,
  model: string,
  opts: { waitMs?: number; deps?: Partial<SizingDeps> } = {},
): Promise<SizingRecord | null> {
  const deps = { ...defaultDeps(), ...opts.deps };
  const key = sizingKey(baseUrl, model);
  const current = entryFor(key, deps.store);
  if (current && deps.now() - current.checkedAt < REVALIDATE_MS) return current.record;
  let run = inflight.get(key);
  if (!run) {
    if (!opts.deps?.kvCacheType && !kvTypeByModel.has(model)) kvTypeByModel.set(model, await profileKvCacheType(model));
    run = decide(sizingRoot(baseUrl), model, deps)
      .then((record) => {
        if (record) entries.set(key, { record, checkedAt: deps.now() });
        return record;
      })
      .catch((e: unknown) => {
        logger.warn(`${model}: context sizing failed, keeping the runtime default: ${(e as Error).message}`);
        return null;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, run);
  }
  if (opts.waitMs === undefined) return run;
  const timer = new Promise<null>((resolve) => { setTimeout(() => resolve(null), opts.waitMs).unref?.(); });
  return (await Promise.race([run, timer])) ?? entryFor(key)?.record ?? null;
}

export function _resetContextSizingForTests(): void {
  entries.clear();
  diskChecked.clear();
  inflight.clear();
  contentionOverrides.clear();
  kvTypeByModel = new Map();
}
