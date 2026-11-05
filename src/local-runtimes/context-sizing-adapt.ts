/**
 * Verify and adapt a context-sizing decision against what the runtime
 * actually did. Called after each chat request that carried the applied
 * num_ctx; reads /api/ps once.
 *
 * /api/ps `size` vs `size_vram` (api/types.go ProcessModelResponse,
 * ollama@16b4376a lines 854-863) is the only signal a load spilled — the
 * request itself returns HTTP 200 either way. Three outcomes:
 *
 *   fully resident            -> the decision is verified (persisted once)
 *   spilled, other models fit -> the estimate was wrong for this machine:
 *     in the headroom, card      step down PERMANENTLY by the spill's worth of
 *     not full                   KV (one reload, not a notch per request)
 *   spilled, other Ollama     -> contention (an eval, another app's model, a
 *     models exceed the          game): step down TEMPORARILY for the next
 *     headroom, or the driver    request
 *     shows the card full
 *
 * A fourth that /api/ps cannot show: on Windows a card filled past its VRAM
 * pages to system memory and the runner reports 100% GPU throughout. qwen3.8
 * 27B decoded at 21 tok/s instead of ~120 that way (2026-11-03), and stayed
 * slow until the model reloaded. Its sign is the reply itself: decode at half
 * the rate this decision has shown fully resident or less, at the same prompt
 * depth, on a card the driver shows all but full or with the runner measured
 * in system memory (Windows counts that per process; free VRAM alone missed a
 * 2 GB spill with 1.1 GB free on 2026-11-05). That steps down temporarily
 * too, which reloads the model.
 *
 * "At the same depth" because a deep prompt slows decode by itself: the 27B
 * ran 186 tok/s a thousand tokens in and 88-110 tok/s 48k tokens in, fully
 * resident (2026-11-05). Judged against the short-prompt rate, that second
 * voice turn read as paging, and the reload it caused threw away the prompt
 * cache the next turn needed.
 *
 * "Full" is the driver's free VRAM under the safety margin. Free, not "used
 * minus what /api/ps reports": Ollama reports qwen3.8 27B at 18 GB while its
 * runner holds ~28 GB, so that subtraction blamed the model's own KV cache on
 * someone else.
 *
 * Thrash guard: a temporary step-down is lifted only after the contention has
 * been observed gone continuously for CONTENTION_COOLDOWN_MS, with free VRAM
 * for the size it gives back, so a model that comes and goes costs at most one
 * reload pair per cooldown.
 */
import { createLogger } from "../logger.js";
import {
  CONTEXT_FLOOR, KV_OVERHEAD_FACTOR, findPsRow, ollamaModelKey, parsePsRows, safetyMarginBytes, spillBytes, steppedDownContext,
} from "./context-sizing-core.js";
import { readGpuUsedBytes, readRunnerSharedBytes } from "./gpu-memory.js";
import {
  appliedContext, contentionOverrides, contextSizingRecord, saveContextSizingRecord, sizingKey, sizingRoot,
} from "./context-sizing.js";
import type { ContextSizingStore, SizingRecord } from "./context-sizing-store.js";

const logger = createLogger("local-runtimes.context-sizing");

export const CONTENTION_COOLDOWN_MS = 10 * 60_000;
/** Estimates of background models are rough; this much over the headroom
 *  they were sized for is not yet contention. */
const HEADROOM_TOLERANCE_BYTES = 512 * 1024 * 1024;
const PS_TIMEOUT_MS = 2_000;
/** Replies shorter than this say too little about decode speed. */
export const MIN_DECODE_TOKENS = 64;
/** A reply this many times slower than the healthy rate at its depth may be
 *  paging: paging cost qwen3.8 27B 2x (a co-loaded 8B: 97 -> 46-50) to 5-7x
 *  (120 -> 21), and 45x (186 -> 4, prefill 3,000 -> 72) on 2026-11-05. */
export const PAGING_SLOWDOWN = 2;
/** The prompt depth at which decode runs at half its short-prompt rate, fully
 *  resident. qwen3.8 27B: 186 -> ~100 tok/s at 48k (halving at ~56k), 147 ->
 *  ~100 at 34k (~72k); the lower one, so depth alone never reads as paging. */
export const DECODE_HALVING_DEPTH = 56_000;
/** ...on a card with less than this free: the line between full and not.
 *  Every paging state measured on the 5090 had 587-954 MiB free; the same
 *  card healthy at the old 172k size had 1,035 MiB, and the margin now leaves
 *  it gigabytes more. Without a driver reading a slow reply is not acted on:
 *  a long context alone could be it. */
const FULL_CARD_FREE_BYTES = 1024 ** 3;
/** ...or with more than this of the runner in system memory (Windows reports
 *  it per process; readRunnerSharedBytes). The runner keeps about 1 GB there
 *  by design, its host-side buffers: 0.95 GB at 64k and 1.09 GB at 147k on
 *  qwen3.8 27B, decoding at 104-111 tok/s. Paging at 18 tok/s showed 2.16 GB
 *  with 1.1 GB of VRAM still free, so the free-VRAM line missed it
 *  (2026-11-05). */
const PAGED_RUNNER_SHARED_BYTES = 1.5 * 1024 ** 3;
/** What a step-down for paging sheds: the overflow measured on the 27B was
 *  under 1 GB; twice that leaves room for it to grow. */
const PAGING_SHED_BYTES = 2 * 1024 ** 3;

export interface AdaptDeps {
  ps: (root: string) => Promise<unknown>;
  /** VRAM in use by every process on this machine's GPUs, or null. */
  gpuUsed: () => Promise<number | null>;
  /** System memory the runtime's runners hold for the GPU, or null (readRunnerSharedBytes). */
  runnerShared: () => Promise<number | null>;
  now: () => number;
  store?: ContextSizingStore;
}

/** The reply's decode, from Ollama's final stream line (eval_count, eval_duration). */
export interface ReplyDecode {
  tokens: number;
  durationNs: number;
  /** The prompt it decoded after, in tokens (prompt_eval_count); 0 when unknown. */
  contextTokens?: number;
}

async function readPs(root: string): Promise<unknown> {
  try {
    const r = await fetch(`${root}/api/ps`, { redirect: "manual", signal: AbortSignal.timeout(PS_TIMEOUT_MS) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** How much slower than at an empty prompt a fully resident model decodes this deep. */
function depthSlowdown(contextTokens: number): number {
  return 1 + contextTokens / DECODE_HALVING_DEPTH;
}

/** The reply's decode rate, as tokens/s, and scaled to an empty prompt: the
 *  measure every yardstick and comparison here uses. */
function decodeRate(reply: ReplyDecode | undefined): { raw: number; shallow: number } | null {
  if (!reply || reply.tokens < MIN_DECODE_TOKENS || reply.durationNs <= 0) return null;
  const raw = reply.tokens / (reply.durationNs / 1e9);
  return { raw, shallow: raw * depthSlowdown(reply.contextTokens ?? 0) };
}

/** Free VRAM per the driver, or null without a measured GPU or a reading. */
async function freeVram(record: SizingRecord, deps: Partial<AdaptDeps>): Promise<number | null> {
  if (record.gpu?.source !== "measured") return null;
  const used = await (deps.gpuUsed ?? readGpuUsedBytes)();
  return used === null ? null : record.gpu.totalBytes - used;
}

/** What shows a slow reply was paging, as the clause the warning ends with, or
 *  null when nothing does: a full card, or the runner measured in system memory. */
async function pagingEvidence(free: number | null, deps: Partial<AdaptDeps>): Promise<string | null> {
  if (free !== null && free < FULL_CARD_FREE_BYTES) return `with ${(free / 1e9).toFixed(1)} GB of VRAM free`;
  const shared = await (deps.runnerShared ?? readRunnerSharedBytes)();
  if (shared !== null && shared > PAGED_RUNNER_SHARED_BYTES) return `with ${(shared / 1e9).toFixed(1)} GB of the runner in system memory`;
  return null;
}

/** Step down until the contention clears; the size stepped to, or null when
 *  already at the floor. It lifts once growing back would still leave the
 *  card short of full. Not the whole safety margin on top: the decided size
 *  never had that free once the margin's other tenants (the desktop, the
 *  voice sidecars) moved in, and a live step-down that asked for it stayed
 *  down after the co-loaded model had gone (2.7 GB free at the decided size,
 *  5.0 GB free stepped down, 5.8 GB asked). */
function stepDownWhileContended(key: string, record: SizingRecord, applied: number, shed: number, now: number): number | null {
  const kv = record.kvBytesPerToken ?? 0;
  const next = steppedDownContext(applied, shed, kv) ?? (applied > CONTEXT_FLOOR ? CONTEXT_FLOOR : null);
  if (next === null) return null;
  const regrow = Math.ceil(((record.numCtx ?? applied) - next) * kv * KV_OVERHEAD_FACTOR);
  contentionOverrides.set(key, { numCtx: next, since: now, clearSince: null, liftWhenFreeBytes: regrow + FULL_CARD_FREE_BYTES });
  return next;
}

/** Observe the chat model's residency after a request and adapt. Never throws. */
export async function observeChatResidency(
  baseUrl: string,
  model: string,
  deps: Partial<AdaptDeps> = {},
  reply?: ReplyDecode,
): Promise<void> {
  const record = contextSizingRecord(baseUrl, model);
  const applied = appliedContext(baseUrl, model);
  if (!record || applied === undefined) return;
  const now = (deps.now ?? Date.now)();
  const rows = parsePsRows(await (deps.ps ?? readPs)(sizingRoot(baseUrl)));
  const row = rows ? findPsRow(rows, model) : null;
  // Only a load at the size LAX asked for says anything about that size.
  if (!rows || !row || row.contextLength !== applied) return;
  const key = sizingKey(baseUrl, model);
  const othersVram = rows
    .filter((r) => ollamaModelKey(r.name) !== ollamaModelKey(model))
    .reduce((sum, r) => sum + r.sizeVramBytes, 0);
  const othersOver = othersVram > record.headroomBytes + HEADROOM_TOLERANCE_BYTES;
  const spill = spillBytes(row);
  const override = contentionOverrides.get(key);
  const rate = decodeRate(reply);
  // Still slow after a step-down: that step was not enough, so take another.
  const slow = spill === 0 && rate !== null && record.healthyDecodeTokPerSec !== undefined
    && rate.shallow * PAGING_SLOWDOWN < record.healthyDecodeTokPerSec;
  const free = spill > 0 || override || slow ? await freeVram(record, deps) : null;
  const cardFull = free !== null && record.gpu !== null && free < safetyMarginBytes(record.gpu.totalBytes);

  if (spill > 0 && (othersOver || cardFull)) {
    const next = stepDownWhileContended(key, record, applied, spill, now);
    if (next !== null) logger.warn(`${model}: ${(spill / 1e9).toFixed(1)} GB spilled to system RAM at ${applied} tokens while other models hold ${(othersVram / 1e9).toFixed(1)} GB of VRAM; running at ${next} tokens until they unload`);
    return;
  }
  if (spill > 0) {
    // The machine holds less than estimated. Shrink the decision itself.
    const next = steppedDownContext(applied, spill, record.kvBytesPerToken ?? 0);
    contentionOverrides.delete(key);
    saveContextSizingRecord({
      ...record,
      numCtx: next,
      reason: next === null ? "spilled_at_floor" : record.reason,
      verification: "stepped_down",
      verifiedAt: new Date(now).toISOString(),
    }, deps.store);
    logger.warn(`${model}: ${(spill / 1e9).toFixed(1)} GB spilled to system RAM at ${applied} tokens with no other model to blame; context is now ${next ?? "the runtime default"}`);
    return;
  }
  const paging = slow ? await pagingEvidence(free, deps) : null;
  if (paging) {
    const next = stepDownWhileContended(key, record, applied, PAGING_SHED_BYTES, now);
    const depth = reply?.contextTokens ?? 0;
    const expected = record.healthyDecodeTokPerSec! / depthSlowdown(depth);
    if (next !== null) logger.warn(`${model}: decoding at ${rate!.raw.toFixed(0)} tok/s ${depth} tokens deep, against ${expected.toFixed(0)} there when fully resident, ${paging}: the card is paging to system memory; reloading at ${next} tokens until it has room`);
    return;
  }
  if (override) {
    const quiet = !othersOver && (free === null || free >= override.liftWhenFreeBytes);
    if (!quiet) { override.clearSince = null; return; }
    override.clearSince ??= now;
    if (now - override.clearSince >= CONTENTION_COOLDOWN_MS) {
      contentionOverrides.delete(key);
      logger.info(`${model}: contention gone for ${CONTENTION_COOLDOWN_MS / 60_000} min; back to ${record.numCtx ?? "the runtime default"} tokens`);
    }
    return;
  }
  recordResident(model, record, row.sizeVramBytes, applied, rate, now, deps.store);
}

/** A fully resident reply at the decided size: verify the decision once, and
 *  keep the fastest decode it has shown as the paging yardstick. */
function recordResident(model: string, record: SizingRecord, vram: number, applied: number, decode: { shallow: number } | null, now: number, store?: ContextSizingStore): void {
  const rate = decode?.shallow ?? null;
  const faster = rate !== null && rate > (record.healthyDecodeTokPerSec ?? 0);
  if (record.verification === "verified" && !faster) return;
  saveContextSizingRecord({
    ...record,
    ...(faster ? { healthyDecodeTokPerSec: Math.round(rate * 10) / 10 } : {}),
    ...(record.verification !== "verified" ? { verification: "verified" as const, verifiedAt: new Date(now).toISOString() } : {}),
  }, store);
  if (record.verification !== "verified") logger.info(`${model}: ${applied} tokens verified fully GPU-resident (${(vram / 1e9).toFixed(1)} GB)`);
}
