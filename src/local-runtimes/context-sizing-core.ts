/**
 * Context sizing — the pure half. Given what the runtime says about a model
 * (/api/show model_info, /api/tags size) and what the machine says about its
 * GPU, choose the largest context the model can run at while staying entirely
 * in VRAM. No I/O here; context-sizing.ts gathers the inputs and applies the
 * answer.
 *
 * Why a model is not simply run at its native window: Ollama allocates the KV
 * cache for the whole num_ctx up front, and a context past what VRAM holds
 * spills layers to system RAM silently — HTTP 200, no warning. qwen3.6:27b at
 * its native 262,144 on a 32 GB card: 33.2 GB total, 86% on GPU, decode
 * 74 -> 19.5 tok/s; at 131,072 it is fully resident at 24.8 GB
 * (docs/harness/audit-notes/runtime-facts.md, measured 2026-09-19).
 *
 * The KV-per-token formula mirrors what Ollama itself uses to predict a load
 * (llm/llama_server.go PredictServerVRAM, ollama@16b4376a lines 2788-2804:
 * 2 x layers x kv_heads x head_dim x ctx x 2 bytes), with two refinements the
 * GGUF metadata allows and Ollama's rough estimate skips:
 *   - per-layer head_count_kv arrays are SUMMED (a hybrid model lists 0 for
 *     its recurrent layers: qwen35 carries KV on 16 of 64 layers), where
 *     Ollama takes the minimum across layers;
 *   - key_length / value_length are read when present instead of deriving
 *     head_dim from embedding_length / head_count.
 * Sliding-window layers (gemma, gpt-oss) and MLA latents (deepseek2) are
 * costed as full attention — an OVERestimate, so those models get a smaller
 * context than would fit, never one that spills.
 */

const GIB = 1024 ** 3;

/** Context sizes move in steps of this many tokens. */
export const CONTEXT_NOTCH = 8_192;
/** Below this the sizing keeps the runtime's own default instead. A window
 *  this small cannot hold a system prompt, a tool manifest and a working
 *  history together; the runtime default is no worse and needs no decision. */
export const CONTEXT_FLOOR = 32_768;
/** Compute buffers, the output layer and runner overhead that ride on top of
 *  the weights. The measured 27B curve (16k 17.3 GB, 32k 18.4, 65k 20.6,
 *  131k 24.8) extrapolates to ~16.2 GB at zero context against a ~17 GB
 *  weights file, so weights + this is already on the safe side. */
export const COMPUTE_RESERVE_BYTES = 1 * GIB;
/** The measured KV slope runs 1-3% above the formula (67,584 B/token on the
 *  27B against 65,536 computed), from compute buffers that grow with ctx. */
export const KV_OVERHEAD_FACTOR = 1.05;
/** VRAM kept free for everything that is not a model: the desktop compositor,
 *  browsers, CUDA context, Ollama's own per-GPU minimum. On the 32 GB box the
 *  27B spill run found ~29 GB usable by Ollama of 34.2e9 bytes. */
export function safetyMarginBytes(gpuTotalBytes: number): number {
  return Math.max(2 * GIB, Math.floor(gpuTotalBytes * 0.1));
}

/** Bytes per KV-cache element for OLLAMA_KV_CACHE_TYPE values (ggml block
 *  sizes: q8_0 is 34 bytes per 32 elements, q4_0 18 per 32). Unknown -> f16. */
export function kvBytesPerElement(cacheType: string | null | undefined): number {
  switch ((cacheType ?? "f16").toLowerCase()) {
    case "f32": return 4;
    case "q8_0": return 34 / 32;
    case "q4_0": return 18 / 32;
    default: return 2;
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function numOrList(v: unknown): number | number[] | null {
  if (Array.isArray(v)) return v.every((x) => num(x) !== null) ? (v as number[]) : null;
  return num(v);
}

/** The architecture prefix of the model_info keys ("qwen3", "qwen35", "llama"). */
export function modelArchitecture(info: Record<string, unknown>): string | null {
  const declared = info["general.architecture"];
  if (typeof declared === "string" && declared) return declared;
  const key = Object.keys(info).find((k) => /^[^.]+\.block_count$/.test(k));
  return key ? key.slice(0, key.indexOf(".")) : null;
}

/** The architecture's native context (model_info "<arch>.context_length"). */
export function nativeContextLength(info: Record<string, unknown>): number | null {
  const arch = modelArchitecture(info);
  const n = arch ? num(info[`${arch}.context_length`]) : null;
  return n && n > 0 ? Math.floor(n) : null;
}

/** KV-cache bytes one token of context costs, or null when model_info lacks
 *  the keys to say. */
export function kvBytesPerToken(info: Record<string, unknown>, cacheType?: string | null): number | null {
  const arch = modelArchitecture(info);
  if (!arch) return null;
  const blocks = num(info[`${arch}.block_count`]);
  const kvHeads = numOrList(info[`${arch}.attention.head_count_kv`]);
  if (blocks === null || blocks === 0 || kvHeads === null) return null;
  const heads = numOrList(info[`${arch}.attention.head_count`]);
  const maxHeads = Array.isArray(heads) ? Math.max(...heads) : heads;
  const embedding = num(info[`${arch}.embedding_length`]);
  const derivedHeadDim = embedding !== null && maxHeads ? embedding / maxHeads : null;
  const keyLen = num(info[`${arch}.attention.key_length`]) ?? derivedHeadDim;
  const valueLen = num(info[`${arch}.attention.value_length`]) ?? keyLen;
  if (keyLen === null || valueLen === null) return null;
  let kvHeadLayers: number;
  if (Array.isArray(kvHeads)) {
    kvHeadLayers = kvHeads.reduce((a, b) => a + b, 0);
  } else {
    // A scalar head count on a hybrid model: only every Nth layer attends.
    const interval = num(info[`${arch}.full_attention_interval`]);
    const attentionLayers = interval && interval > 1 ? Math.ceil(blocks / interval) : blocks;
    kvHeadLayers = attentionLayers * kvHeads;
  }
  return Math.round(kvHeadLayers * (keyLen + valueLen) * kvBytesPerElement(cacheType));
}

/** Estimated resident bytes of `weightsBytes` + a `ctx`-token KV cache. */
export function estimateResidentBytes(weightsBytes: number, kvPerToken: number, ctx: number): number {
  return weightsBytes + COMPUTE_RESERVE_BYTES + Math.ceil(ctx * kvPerToken * KV_OVERHEAD_FACTOR);
}

export interface GpuMemory {
  /** "NVIDIA GeForce RTX 5090", or several joined with " + ". */
  name: string;
  totalBytes: number;
  /** "measured" = the driver reported it; "estimated" = unified memory whose
   *  GPU share had to be assumed (Apple Silicon). */
  source: "measured" | "estimated";
}

export type SizingReason =
  | "fits_gpu"          // numCtx chosen: the largest that fits
  | "native_max_fits"   // numCtx = the model's native window, and it fits
  | "remote_runtime"    // the runtime is on another machine; this GPU is irrelevant
  | "gpu_unknown"       // no VRAM figure for this machine (AMD, no driver tool)
  | "model_info_incomplete"
  | "native_below_floor"
  | "gpu_too_small"     // even CONTEXT_FLOOR would not fit with the headroom
  | "spilled_at_floor"; // verification saw a spill with nothing smaller to try

export interface SizingInput {
  nativeMax: number | null;
  weightsBytes: number | null;
  kvBytesPerToken: number | null;
  gpu: GpuMemory | null;
  /** VRAM the OTHER local models LAX keeps resident will occupy. */
  headroomBytes: number;
}

export interface SizingChoice {
  /** The num_ctx to send, or null = send none (the runtime's default). */
  numCtx: number | null;
  reason: SizingReason;
  /** VRAM this choice expects to occupy / the budget it was fitted into. */
  estimatedBytes: number | null;
  budgetBytes: number | null;
}

const roundDownToNotch = (n: number) => Math.floor(n / CONTEXT_NOTCH) * CONTEXT_NOTCH;

/** The largest context <= the native window that fits the GPU budget. Never
 *  guesses upward: any unknown input keeps the runtime default. */
export function chooseContext(input: SizingInput): SizingChoice {
  const keep = (reason: SizingReason, budgetBytes: number | null = null): SizingChoice =>
    ({ numCtx: null, reason, estimatedBytes: null, budgetBytes });
  if (!input.gpu || input.gpu.totalBytes <= 0) return keep("gpu_unknown");
  if (input.nativeMax === null || input.weightsBytes === null || input.kvBytesPerToken === null) {
    return keep("model_info_incomplete");
  }
  if (input.nativeMax < CONTEXT_FLOOR) return keep("native_below_floor");
  const budget = input.gpu.totalBytes - safetyMarginBytes(input.gpu.totalBytes) - input.headroomBytes;
  const forKv = budget - input.weightsBytes - COMPUTE_RESERVE_BYTES;
  const kvToken = input.kvBytesPerToken * KV_OVERHEAD_FACTOR;
  const fitting = kvToken > 0 ? Math.floor(forKv / kvToken) : forKv >= 0 ? Infinity : -1;
  const atNative = fitting >= input.nativeMax;
  const numCtx = atNative ? input.nativeMax : roundDownToNotch(fitting);
  if (numCtx < CONTEXT_FLOOR) return keep("gpu_too_small", budget);
  return {
    numCtx,
    reason: atNative ? "native_max_fits" : "fits_gpu",
    estimatedBytes: estimateResidentBytes(input.weightsBytes, input.kvBytesPerToken, numCtx),
    budgetBytes: budget,
  };
}

/** One loaded model as /api/ps reports it (api/types.go ProcessModelResponse). */
export interface PsRow {
  name: string;
  sizeBytes: number;
  sizeVramBytes: number;
  contextLength: number | null;
}

/** Ollama aliases an untagged name to ":latest"; nothing else is normalized. */
export function ollamaModelKey(id: string): string {
  return id.includes(":") ? id : `${id}:latest`;
}

export function parsePsRows(ps: unknown): PsRow[] | null {
  const models = ps && typeof ps === "object" ? (ps as { models?: unknown }).models : null;
  if (!Array.isArray(models)) return null;
  const rows: PsRow[] = [];
  for (const m of models) {
    if (!m || typeof m !== "object") continue;
    const r = m as { name?: unknown; model?: unknown; size?: unknown; size_vram?: unknown; context_length?: unknown };
    const name = typeof r.name === "string" ? r.name : typeof r.model === "string" ? r.model : null;
    const size = num(r.size);
    if (!name || size === null) continue;
    const ctx = num(r.context_length);
    rows.push({ name, sizeBytes: size, sizeVramBytes: num(r.size_vram) ?? 0, contextLength: ctx && ctx > 0 ? ctx : null });
  }
  return rows;
}

export function findPsRow(rows: readonly PsRow[], model: string): PsRow | null {
  const wanted = ollamaModelKey(model);
  return rows.find((r) => ollamaModelKey(r.name) === wanted) ?? null;
}

/** Bytes of `row` living outside VRAM. Under 1% counts as none: a runner can
 *  keep a few MB host-side without any layer being offloaded. */
export function spillBytes(row: PsRow): number {
  const spill = Math.max(0, row.sizeBytes - row.sizeVramBytes);
  return spill <= row.sizeBytes * 0.01 ? 0 : spill;
}

/**
 * The context that would have fitted, given a load at `ctx` that left
 * `spill` bytes outside VRAM: shed the spill's worth of KV, rounded down a
 * notch, at least one notch below `ctx`. Null when that is under the floor.
 */
export function steppedDownContext(ctx: number, spill: number, kvPerToken: number): number | null {
  const shed = kvPerToken > 0 ? Math.ceil(spill / (kvPerToken * KV_OVERHEAD_FACTOR)) : CONTEXT_NOTCH;
  const next = Math.min(roundDownToNotch(ctx - shed), roundDownToNotch(ctx) - CONTEXT_NOTCH);
  return next >= CONTEXT_FLOOR ? next : null;
}
