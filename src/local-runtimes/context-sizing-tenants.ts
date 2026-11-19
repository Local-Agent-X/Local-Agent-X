/**
 * Room for the programs that share the GPU with Ollama, read before a turn.
 *
 * The decided context (context-sizing.ts) leaves a fixed safety margin for
 * everything that is not a model. A voice engine is more than that margin
 * holds: with VoxCPM (5.6 GB), the Lite voice sidecar and a VPN client on the
 * 5090, qwen3.8 27B at its decided 147,456 tokens put 5.8 GB of itself in
 * system memory, and a voice reply took 112 s to start, its prompt read at
 * 1,000 tok/s and its decode falling under 1 tok/s (2026-11-18). Alone on the
 * card the same size decodes at 101 tok/s with 3.2 GB free.
 *
 * So before each turn (at most every CHECK_EVERY_MS) this measures what the
 * other programs hold: the driver's used VRAM less what Ollama's models hold.
 * Ollama's own figure for the chat model is not used, since /api/ps reports
 * the 27B at 18 GB while its runner holds ~28 GB; its size comes from the
 * sizing estimate at the context it is loaded at. When the others hold more
 * than the margin left room for, the model runs smaller until they go: a
 * contention step-down, lifted by context-sizing-adapt.ts once the card has
 * room for the decided size again.
 */
import { createLogger } from "../logger.js";
import {
  CONTEXT_FLOOR, KV_OVERHEAD_FACTOR, chooseContext, estimateResidentBytes, findPsRow, ollamaModelKey, parsePsRows,
  safetyMarginBytes, type PsRow,
} from "./context-sizing-core.js";
import { appliedContext, contentionOverrides, contextSizingRecord, sizingKey, sizingRoot } from "./context-sizing.js";
import { readPs } from "./context-sizing-adapt.js";
import type { SizingRecord } from "./context-sizing-store.js";
import { readGpuUsedBytes } from "./gpu-memory.js";

const logger = createLogger("local-runtimes.context-sizing");

/** How often the other programs' VRAM is read; a reading costs ~100 ms. */
export const CHECK_EVERY_MS = 15_000;
/** Room kept free above what the other programs hold when they are measured:
 *  the measurement and the estimate are each good to about half a gigabyte. */
export const TENANT_SLACK_BYTES = 1024 ** 3;
/** The free VRAM the decided size needs on top of its regrowth before a
 *  step-down lifts (as in context-sizing-adapt.ts). */
const LIFT_FREE_BYTES = 1024 ** 3;

export interface TenantDeps {
  ps: (root: string) => Promise<unknown>;
  /** VRAM in use by every process on this machine's GPUs, or null. */
  gpuUsed: () => Promise<number | null>;
  now: () => number;
}

const lastCheck = new Map<string, number>();

/** VRAM Ollama's loaded models hold: the chat model by the sizing estimate at
 *  the context it is loaded at, any other by what /api/ps reports. */
export function ollamaHeldBytes(rows: PsRow[], model: string, record: SizingRecord): number {
  const chat = findPsRow(rows, model);
  const others = rows
    .filter((r) => ollamaModelKey(r.name) !== ollamaModelKey(model))
    .reduce((sum, r) => sum + r.sizeVramBytes, 0);
  if (!chat) return others;
  const ctx = chat.contextLength ?? record.numCtx ?? 0;
  const estimated = record.weightsBytes !== null && record.kvBytesPerToken !== null
    ? estimateResidentBytes(record.weightsBytes, record.kvBytesPerToken, ctx)
    : chat.sizeVramBytes;
  return others + Math.max(estimated, chat.sizeVramBytes);
}

/** The context that fits beside `othersBytes` of other programs, or null when
 *  the safety margin already covers them. Never above the decided size. */
export function fitBesideOthers(record: SizingRecord, othersBytes: number): number | null {
  if (!record.gpu || record.numCtx === null || record.nativeMax === null) return null;
  const beyondMargin = othersBytes + TENANT_SLACK_BYTES - safetyMarginBytes(record.gpu.totalBytes);
  if (beyondMargin <= 0) return null;
  const choice = chooseContext({
    nativeMax: record.nativeMax,
    weightsBytes: record.weightsBytes,
    kvBytesPerToken: record.kvBytesPerToken,
    gpu: record.gpu,
    headroomBytes: record.headroomBytes + beyondMargin,
    declaredCtx: null,
  });
  return Math.min(choice.numCtx ?? CONTEXT_FLOOR, record.numCtx);
}

/**
 * Step the chat model's context down when other programs hold more VRAM than
 * the margin left room for. Throttled per model; never throws.
 */
export async function fitAroundOtherPrograms(baseUrl: string, model: string, deps: Partial<TenantDeps> = {}): Promise<void> {
  try {
    const record = contextSizingRecord(baseUrl, model);
    if (!record || record.numCtx === null || record.gpu?.source !== "measured") return;
    const key = sizingKey(baseUrl, model);
    const now = (deps.now ?? Date.now)();
    if (now - (lastCheck.get(key) ?? -Infinity) < CHECK_EVERY_MS) return;
    lastCheck.set(key, now);
    const [used, ps] = await Promise.all([(deps.gpuUsed ?? readGpuUsedBytes)(), (deps.ps ?? readPs)(sizingRoot(baseUrl))]);
    const rows = parsePsRows(ps);
    if (used === null || !rows) return;
    const others = Math.max(0, used - ollamaHeldBytes(rows, model, record));
    const fit = fitBesideOthers(record, others);
    const applied = appliedContext(baseUrl, model) ?? record.numCtx;
    if (fit === null || fit >= applied) return;
    const regrow = Math.ceil((record.numCtx - fit) * (record.kvBytesPerToken ?? 0) * KV_OVERHEAD_FACTOR);
    contentionOverrides.set(key, { numCtx: fit, since: now, clearSince: null, liftWhenFreeBytes: regrow + LIFT_FREE_BYTES });
    logger.warn(`${model}: other programs hold ${(others / 1e9).toFixed(1)} GB of VRAM, more than the margin left room for; running at ${fit} tokens instead of ${applied} until they free it`);
  } catch { /* a reading that fails leaves the size as it was */ }
}

export function _resetTenantChecksForTests(): void {
  lastCheck.clear();
}
