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
 *     in the headroom            step down PERMANENTLY by the spill's worth of
 *                                KV (one reload, not a notch per request)
 *   spilled, other Ollama     -> contention (an eval, another app's model, a
 *     models exceed the          game): step down TEMPORARILY for the next
 *     headroom, or the driver    request
 *     shows VRAM held outside
 *     Ollama past the margin
 *
 * Thrash guard: a temporary step-down is lifted only after the contention has
 * been observed gone continuously for CONTENTION_COOLDOWN_MS, so a model that
 * comes and goes costs at most one reload pair per cooldown.
 */
import { createLogger } from "../logger.js";
import {
  CONTEXT_FLOOR, findPsRow, ollamaModelKey, parsePsRows, safetyMarginBytes, spillBytes, steppedDownContext,
} from "./context-sizing-core.js";
import { readGpuUsedBytes } from "./gpu-memory.js";
import {
  appliedContext, contentionOverrides, contextSizingRecord, saveContextSizingRecord, sizingKey, sizingRoot,
} from "./context-sizing.js";
import type { ContextSizingStore } from "./context-sizing-store.js";

const logger = createLogger("local-runtimes.context-sizing");

export const CONTENTION_COOLDOWN_MS = 10 * 60_000;
/** Estimates of background models are rough; this much over the headroom
 *  they were sized for is not yet contention. */
const HEADROOM_TOLERANCE_BYTES = 512 * 1024 * 1024;
const PS_TIMEOUT_MS = 2_000;

export interface AdaptDeps {
  ps: (root: string) => Promise<unknown>;
  /** VRAM in use by every process on this machine's GPUs, or null. */
  gpuUsed: () => Promise<number | null>;
  now: () => number;
  store?: ContextSizingStore;
}

async function readPs(root: string): Promise<unknown> {
  try {
    const r = await fetch(`${root}/api/ps`, { redirect: "manual", signal: AbortSignal.timeout(PS_TIMEOUT_MS) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Observe the chat model's residency after a request and adapt. Never throws. */
export async function observeChatResidency(
  baseUrl: string,
  model: string,
  deps: Partial<AdaptDeps> = {},
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
  const spill = spillBytes(row);
  const override = contentionOverrides.get(key);
  const kv = record.kvBytesPerToken ?? 0;
  let contended = othersVram > record.headroomBytes + HEADROOM_TOLERANCE_BYTES;
  // A game or a browser holding VRAM is invisible to /api/ps. When a spill
  // (or an active step-down) needs explaining, ask the driver how much VRAM
  // is held outside Ollama; past the safety margin that is contention too,
  // never a reason to shrink the decision for good.
  if (!contended && (spill > 0 || override) && record.gpu?.source === "measured") {
    const used = await (deps.gpuUsed ?? readGpuUsedBytes)();
    const ollamaVram = rows.reduce((sum, r) => sum + r.sizeVramBytes, 0);
    if (used !== null) contended = used - ollamaVram > safetyMarginBytes(record.gpu.totalBytes);
  }

  if (spill > 0 && contended) {
    const next = steppedDownContext(applied, spill, kv) ?? (applied > CONTEXT_FLOOR ? CONTEXT_FLOOR : null);
    if (next === null) return; // already at the floor: the spill is the other model's doing
    contentionOverrides.set(key, { numCtx: next, since: now, clearSince: null });
    logger.warn(`${model}: ${(spill / 1e9).toFixed(1)} GB spilled to system RAM at ${applied} tokens while other models hold ${(othersVram / 1e9).toFixed(1)} GB of VRAM; running at ${next} tokens until they unload`);
    return;
  }
  if (spill > 0) {
    // The machine holds less than estimated. Shrink the decision itself.
    const next = steppedDownContext(applied, spill, kv);
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
  if (override) {
    if (contended) { override.clearSince = null; return; }
    override.clearSince ??= now;
    if (now - override.clearSince >= CONTENTION_COOLDOWN_MS) {
      contentionOverrides.delete(key);
      logger.info(`${model}: contention gone for ${CONTENTION_COOLDOWN_MS / 60_000} min; back to ${record.numCtx ?? "the runtime default"} tokens`);
    }
    return;
  }
  if (record.verification !== "verified") {
    saveContextSizingRecord({ ...record, verification: "verified", verifiedAt: new Date(now).toISOString() }, deps.store);
    logger.info(`${model}: ${applied} tokens verified fully GPU-resident (${(row.sizeVramBytes / 1e9).toFixed(1)} GB)`);
  }
}
