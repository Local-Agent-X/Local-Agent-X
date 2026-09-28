/**
 * Fixtures for the context-sizing tests: the two reference models as Ollama
 * 0.34.2 described them (docs/harness/phase0-evidence/probe-results.core.*.json,
 * 2026-09-19, plus the general.architecture key every /api/show carries) and
 * the reference box's GPU. A fake /api/* answerer over them.
 */
import type { GpuMemory } from "./context-sizing-core.js";

export const QWEN36_27B_INFO: Record<string, unknown> = {
  "general.architecture": "qwen35",
  "qwen35.attention.head_count": 24,
  "qwen35.attention.head_count_kv": Array.from({ length: 64 }, (_, i) => (i % 4 === 3 ? 4 : 0)),
  "qwen35.attention.key_length": 256,
  "qwen35.block_count": 64,
  "qwen35.context_length": 262_144,
  "qwen35.embedding_length": 5120,
  "qwen35.vision.block_count": 27,
  "qwen35.vision.attention.head_count": 16,
};

export const QWEN3_8B_INFO: Record<string, unknown> = {
  "general.architecture": "qwen3",
  "qwen3.attention.head_count": 32,
  "qwen3.attention.head_count_kv": 8,
  "qwen3.attention.key_length": 128,
  "qwen3.block_count": 36,
  "qwen3.context_length": 40_960,
  "qwen3.embedding_length": 4096,
};

/** nvidia-smi memory.total for the RTX 5090 on the reference box: 32607 MiB. */
export const RTX_5090: GpuMemory = { name: "NVIDIA GeForce RTX 5090", totalBytes: 32_607 * 1024 * 1024, source: "measured" };

/** Library sizes of the Q4_K_M tags (ollama.com lists 17 GB and 5.2 GB). */
export const WEIGHTS_27B = 17_000_000_000;
export const WEIGHTS_8B = 5_225_000_000;
/** mxbai-embed-large as /api/ps measured it resident. */
export const EMBEDDER_VRAM = 618_387_209;

export interface FakeRuntimeState {
  version: string;
  models: Array<{ name: string; size: number; digest: string; info: Record<string, unknown> | null }>;
  ps: Array<{ name: string; size: number; size_vram: number; context_length?: number }>;
  calls: string[];
}

export function referenceRuntime(): FakeRuntimeState {
  return {
    version: "0.34.2",
    models: [
      { name: "qwen3.6:27b", size: WEIGHTS_27B, digest: "sha256:27b", info: QWEN36_27B_INFO },
      { name: "qwen3:8b", size: WEIGHTS_8B, digest: "sha256:8b", info: QWEN3_8B_INFO },
      { name: "mxbai-embed-large:latest", size: 669_615_493, digest: "sha256:mx", info: null },
    ],
    ps: [{ name: "mxbai-embed-large:latest", size: EMBEDDER_VRAM, size_vram: EMBEDDER_VRAM }],
    calls: [],
  };
}

/** A fetchJson stand-in answering /api/version, /api/tags, /api/ps, /api/show. */
export function fakeFetchJson(state: FakeRuntimeState) {
  return async (url: string, init?: RequestInit): Promise<Record<string, unknown> | null> => {
    const path = new URL(url).pathname;
    state.calls.push(path);
    if (path === "/api/version") return { version: state.version };
    if (path === "/api/tags") return { models: state.models.map(({ name, size, digest }) => ({ name, model: name, size, digest })) };
    if (path === "/api/ps") return { models: state.ps };
    if (path === "/api/show") {
      const model = (JSON.parse(String(init?.body)) as { model: string }).model;
      const hit = state.models.find((m) => m.name === model || m.name === `${model}:latest`);
      return hit ? { model_info: hit.info ?? {}, capabilities: ["completion", "tools"] } : null;
    }
    return null;
  };
}
