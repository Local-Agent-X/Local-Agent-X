/**
 * Model residency + background warm-up for the local Ollama-native runtime.
 *
 * Why: the first /api/generate after idle pays the model cold-load INSIDE the
 * caller's timeout — 16.5s observed on this box (2026-07) against classifier
 * wallclocks of 3s. The caller burns its whole budget on a load whose result
 * it never sees, and may pay it again next turn. The honest primitives:
 *
 *   isModelResident() — ask the runtime what is actually loaded (/api/ps) so
 *     short-budget callers can skip a call that cannot succeed in time.
 *   warmModel()       — fire-and-forget load with keep_alive so the NEXT
 *     call runs hot.
 *
 * Deliberately config-blind: callers pass the baseUrl they would have
 * dispatched to. Consumers: the classifier cold-skip (classify-with-llm.ts);
 * chat-side pre-warm rides the same helpers.
 */
import { createLogger } from "../logger.js";

const logger = createLogger("local-runtimes");

const PS_TIMEOUT_MS = 2_000;
// Generous on purpose: the warm request's entire job is to sit through the
// cold load (16.5s observed; bigger models slower). Aborting mid-load risks
// cancelling the very load we asked for, and the promise is detached — a
// pending warm costs the caller nothing. This cap only bounds a hung socket.
const WARM_TIMEOUT_MS = 60_000;

/** How long the runtime holds a model in memory after a call. One knob,
 *  shared with callOllama's keep_alive, so warmed and real calls extend the
 *  same residency window instead of drifting. */
export const MODEL_KEEP_ALIVE = "30m";

/** Ollama aliases an untagged name to ":latest" ("llama3" and "llama3:latest"
 *  are the same model). Only that default-tag alias is normalized — real tag
 *  variants stay distinct: "llama3.2:3b" vs "llama3.2:3b-instruct" are
 *  different models and must never cross-match. */
function withDefaultTag(id: string): string {
  return id.includes(":") ? id : `${id}:latest`;
}

/**
 * Is `model` loaded in memory on the runtime at `baseUrl`?
 *   true  — /api/ps lists it.
 *   false — /api/ps answered and it is not there. (Note: /api/ps cannot
 *           distinguish "installed but cold" from "not installed at all".)
 *   null  — cannot tell (unreachable, timeout, non-OK, malformed). Callers
 *           MUST treat null as "proceed as before", never as cold. Never
 *           throws.
 * `timeoutMs` bounds the probe (default 2s). Callers running under a tight
 * wallclock pass a slice of their own budget so a hung /api/ps socket can
 * never cost more than the call it was trying to save.
 */
export async function isModelResident(
  baseUrl: string,
  model: string,
  timeoutMs: number = PS_TIMEOUT_MS,
  redirect?: "follow" | "error" | "manual",
): Promise<boolean | null> {
  const loaded = await loadedModel(baseUrl, model, timeoutMs, redirect);
  return loaded === null ? null : loaded !== false;
}

/** The /api/ps row for `model`: its served context when loaded (null if the
 *  runtime didn't report one), false when not loaded, null when unknowable. */
/** One background dispatch asks /api/ps twice — once for the cold-skip check,
 *  again inside dispatchNumCtx to size the call. The answer cannot change in
 *  the microseconds between them, so the second read is pure latency and an
 *  extra round trip the caller's wallclock pays for (it also broke the exact
 *  request sequence test/local-background-target-routing.test.ts pins). Cached
 *  per (baseUrl, redirect) for one call's worth of time, and dropped the moment
 *  a warm changes what is loaded. */
const PS_CACHE_MS = 1_000;
const psCache = new Map<string, { at: number; rows: unknown[] | null }>();

function invalidateResidencyCache(baseUrl: string): void {
  const base = baseUrl.replace(/\/+$/, "");
  for (const key of psCache.keys()) if (key.startsWith(`${base}|`)) psCache.delete(key);
}

/** Test-only: drop every cached probe. Production invalidation is per-warm
 *  (above) plus the 1s expiry; a test that scripts several different /api/ps
 *  answers in the same millisecond needs the slate cleared between them. */
export function _resetResidencyCache(): void {
  psCache.clear();
}

async function psRows(
  baseUrl: string,
  timeoutMs: number,
  redirect?: "follow" | "error" | "manual",
): Promise<unknown[] | null> {
  const base = baseUrl.replace(/\/+$/, "");
  const key = `${base}|${redirect ?? "follow"}`;
  const hit = psCache.get(key);
  if (hit && Date.now() - hit.at < PS_CACHE_MS) return hit.rows;
  const res = await fetch(`${base}/api/ps`, {
    signal: AbortSignal.timeout(timeoutMs),
    ...(redirect ? { redirect } : {}),
  });
  let rows: unknown[] | null = null;
  if (res.ok) {
    const data: unknown = await res.json();
    const models = data && typeof data === "object" ? (data as { models?: unknown }).models : null;
    rows = Array.isArray(models) ? models : null;
  }
  psCache.set(key, { at: Date.now(), rows });
  return rows;
}

async function loadedModel(
  baseUrl: string,
  model: string,
  timeoutMs: number,
  redirect?: "follow" | "error" | "manual",
): Promise<{ contextLength: number | null } | false | null> {
  try {
    const models = await psRows(baseUrl, timeoutMs, redirect);
    if (models === null) return null;
    const wanted = withDefaultTag(model);
    for (const m of models) {
      if (!m || typeof m !== "object") continue;
      const row = m as { name?: unknown; model?: unknown; context_length?: unknown };
      const matches = (typeof row.name === "string" && withDefaultTag(row.name) === wanted)
        || (typeof row.model === "string" && withDefaultTag(row.model) === wanted);
      if (!matches) continue;
      const ctx = row.context_length;
      return { contextLength: typeof ctx === "number" && Number.isInteger(ctx) && ctx > 0 ? ctx : null };
    }
    return false;
  } catch (e) {
    logger.debug(`residency probe failed (${baseUrl}): ${(e as Error).message}`);
    return null;
  }
}

/**
 * Loaded-context size for single-shot dispatch calls (classifiers, background
 * extraction) to a model that isn't loaded yet. Without it Ollama's auto
 * default loads the model with min(model_max, 131072) context, and the KV cache
 * for that window dwarfs the weights — a 2GB llama3.2:3b occupied 17GB of VRAM
 * (observed 2026-08-25). 16384 is many times the largest dispatch prompt while
 * keeping the KV footprint in the hundreds of MB.
 */
export const DISPATCH_NUM_CTX = 16_384;

/** Largest model LAX treats as dispatch-sized (the classifier auto-pick cap). */
export const DISPATCH_MODEL_MAX_BYTES = 6e9;

/**
 * num_ctx for a background /api/generate (dispatch or warm) to `model`.
 *
 * Invariant: a background call never resizes a model someone is chatting with.
 * Ollama reloads a runner whenever the requested num_ctx differs from the
 * loaded one, so a fixed dispatch size reloaded the 17GB chat model at 16k
 * whenever a classifier fell back to it, and the chat preflight then refused
 * turns against the shrunken window (op-outcomes baseline 2026-09-15: six
 * reloads in four minutes, three failed runs).
 *
 *   loaded                         → its current context: the runner is reused
 *   the held chat model, or a model
 *   larger than dispatch-sized      → undefined: Ollama's default, the same
 *                                     shape a /v1 chat request loads
 *   dispatch-sized, not loaded      → DISPATCH_NUM_CTX
 *
 * `sizeBytes` comes from the caller's discovery cache (unknown → not
 * dispatch-sized), so this module stays free of runtime-discovery imports.
 */
export async function dispatchNumCtx(
  baseUrl: string,
  model: string,
  sizeBytes: number | undefined,
  timeoutMs: number = PS_TIMEOUT_MS,
  redirect?: "follow" | "error" | "manual",
): Promise<number | undefined> {
  const loaded = await loadedModel(baseUrl, model, timeoutMs, redirect);
  if (loaded) return loaded.contextLength ?? undefined;
  const base = baseUrl.replace(/\/+$/, "");
  if (heldChat?.key === `${base}|${model}`) return undefined;
  return typeof sizeBytes === "number" && sizeBytes > 0 && sizeBytes <= DISPATCH_MODEL_MAX_BYTES
    ? DISPATCH_NUM_CTX
    : undefined;
}

// One in-flight warm per (baseUrl, model). Every cold turn re-fires warmModel
// while the first load is still running; stacked /api/generate calls for the
// same model would just queue inside the runtime for no gain. Entries clear
// on settle so a model that idles out later can be warmed again.
const inflightWarms = new Map<string, Promise<void>>();

/**
 * Fire-and-forget: load `model` and hold it for MODEL_KEEP_ALIVE. Empty
 * prompt + stream:false is the documented warm-up shape — the runtime loads
 * the model and returns without generating. Never throws, never blocks the
 * caller. A warm is advisory — its failure is debug-noise, not a hidden
 * outage: the next REAL call still surfaces any genuine failure loudly.
 */
/**
 * Re-up cadence for the held chat model. Must beat Ollama's 5-minute default
 * keep_alive: the OpenAI-compat /v1 endpoint IGNORES a keep_alive body field
 * (verified against live Ollama 2026-08-25 — UNTIL stayed at the default),
 * so every real chat request resets the model's expiry to that 5m default no
 * matter what an earlier warm asked for. A one-shot post-turn warm therefore
 * still idles out 5m after the last turn; only a re-up that lands inside
 * every possible 5m window keeps the model hot. 4m does.
 */
const CHAT_RESIDENCY_REUP_MS = 4 * 60_000;

// One hold at a time, matching "the user's current local chat model". Moving
// the hold on a model switch lets the runtime evict the old model instead of
// two 17GB models fighting for VRAM — the exact thrash this exists to end.
let heldChat: { key: string; timer: ReturnType<typeof setInterval> } | null = null;

/**
 * Keep `model` resident on the Ollama-native runtime at `baseUrl` until the
 * hold moves to another model. Idempotent per (baseUrl, model); switching
 * targets releases the previous hold. Fire-and-forget like warmModel — a
 * failed re-up is debug-noise and the next real call surfaces any genuine
 * outage. Ollama-native only (rides /api/generate); OpenAI-compat-only
 * runtimes (LM Studio, vLLM) manage their own TTLs.
 */
export function holdChatModelResidency(baseUrl: string, model: string): void {
  const base = baseUrl.replace(/\/+$/, "");
  const key = `${base}|${model}`;
  if (heldChat?.key === key) return;
  if (heldChat) clearInterval(heldChat.timer);
  warmModel(base, model);
  const timer = setInterval(() => warmModel(base, model), CHAT_RESIDENCY_REUP_MS);
  timer.unref?.();
  heldChat = { key, timer };
}

/** Drop the current hold (model switch away from local, shutdown, tests). */
export function releaseChatModelResidency(): void {
  if (heldChat) {
    clearInterval(heldChat.timer);
    heldChat = null;
  }
}

export function warmModel(
  baseUrl: string,
  model: string,
  redirect?: "follow" | "error" | "manual",
  numCtx?: number,
): void {
  const base = baseUrl.replace(/\/+$/, "");
  const key = `${base}|${model}|${redirect ?? "follow"}|${numCtx ?? "default"}`;
  if (inflightWarms.has(key)) return;
  // A warm changes what is loaded and at what context — the one event that
  // makes a cached /api/ps answer a lie.
  invalidateResidencyCache(base);
  const run = (async () => {
    try {
      const res = await fetch(`${base}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // num_ctx (when given) sizes the LOADED context. The warm decides the
        // model's KV footprint for every call that follows it — a warm without
        // it loads Ollama's auto default (131k on this generation), whose KV
        // cache can be 8x the weights. Classifier warms pass the dispatch
        // window so the warmed shape matches the real call; the chat-residency
        // hold omits it on purpose (chat wants the full window).
        body: JSON.stringify({
          model, prompt: "", stream: false, keep_alive: MODEL_KEEP_ALIVE,
          ...(numCtx !== undefined ? { options: { num_ctx: numCtx } } : {}),
        }),
        signal: AbortSignal.timeout(WARM_TIMEOUT_MS),
        ...(redirect ? { redirect } : {}),
      });
      logger.debug(res.ok
        ? `warm completed (model=${model})`
        : `warm failed: HTTP ${res.status} (model=${model})`);
    } catch (e) {
      logger.debug(`warm failed (model=${model}): ${(e as Error).message}`);
    } finally {
      inflightWarms.delete(key);
    }
  })();
  inflightWarms.set(key, run);
}
