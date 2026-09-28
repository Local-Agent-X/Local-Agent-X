import { describe, expect, it } from "vitest";
import {
  CONTEXT_FLOOR,
  chooseContext,
  findPsRow,
  kvBytesPerToken,
  nativeContextLength,
  parsePsRows,
  spillBytes,
  steppedDownContext,
} from "./context-sizing-core.js";

import {
  EMBEDDER_VRAM, QWEN36_27B_INFO, QWEN3_8B_INFO, RTX_5090, WEIGHTS_27B, WEIGHTS_8B,
} from "./context-sizing.test-helper.js";

describe("kvBytesPerToken", () => {
  it("sums a hybrid model's per-layer KV heads: 16 of 64 qwen35 layers attend", () => {
    // 16 layers x 4 heads x (256 + 256) x 2 bytes. Measured slope 63.6-67.6 KB/token.
    expect(kvBytesPerToken(QWEN36_27B_INFO)).toBe(65_536);
  });

  it("uses block_count x head_count_kv for a uniform model", () => {
    // 36 x 8 x (128 + 128) x 2 = 147,456 (runtime-facts.md: ~144 KB/token).
    expect(kvBytesPerToken(QWEN3_8B_INFO)).toBe(147_456);
  });

  it("scales with the KV cache type", () => {
    expect(kvBytesPerToken(QWEN3_8B_INFO, "q8_0")).toBe(Math.round(36 * 8 * 256 * (34 / 32)));
    expect(kvBytesPerToken(QWEN3_8B_INFO, "q4_0")).toBe(Math.round(36 * 8 * 256 * (18 / 32)));
  });

  it("derives head_dim from embedding / head_count when key_length is absent (Ollama's own estimate)", () => {
    const info = { ...QWEN3_8B_INFO };
    delete info["qwen3.attention.key_length"];
    expect(kvBytesPerToken(info)).toBe(36 * 8 * (128 + 128) * 2);
  });

  it("honours full_attention_interval on a scalar-headed hybrid", () => {
    const info = {
      "general.architecture": "qwen3next", "qwen3next.block_count": 48, "qwen3next.attention.head_count": 16,
      "qwen3next.attention.head_count_kv": 2, "qwen3next.attention.key_length": 256, "qwen3next.full_attention_interval": 4,
    };
    expect(kvBytesPerToken(info)).toBe(12 * 2 * 512 * 2);
  });

  it("is null when model_info cannot say", () => {
    expect(kvBytesPerToken({})).toBeNull();
    expect(kvBytesPerToken({ "general.architecture": "x", "x.block_count": 10 })).toBeNull();
  });

  it("reads the native window from <arch>.context_length, ignoring the vision tower", () => {
    expect(nativeContextLength(QWEN36_27B_INFO)).toBe(262_144);
    const noArch = { ...QWEN36_27B_INFO };
    delete noArch["general.architecture"];
    expect(nativeContextLength(noArch)).toBe(262_144);
  });
});

describe("chooseContext", () => {
  const base = { gpu: RTX_5090, headroomBytes: EMBEDDER_VRAM };

  it("27B on a 32 GB card: the largest 8k multiple that fits, well under the spilling native 262k", () => {
    const choice = chooseContext({
      ...base, nativeMax: 262_144, weightsBytes: WEIGHTS_27B, kvBytesPerToken: kvBytesPerToken(QWEN36_27B_INFO),
    });
    expect(choice).toMatchObject({ numCtx: 172_032, reason: "fits_gpu" });
    expect(choice.numCtx! % 8192).toBe(0);
    expect(choice.estimatedBytes!).toBeLessThanOrEqual(choice.budgetBytes!);
  });

  it("8B on a 32 GB card: its whole native 40,960", () => {
    expect(chooseContext({
      ...base, nativeMax: 40_960, weightsBytes: WEIGHTS_8B, kvBytesPerToken: kvBytesPerToken(QWEN3_8B_INFO),
    })).toMatchObject({ numCtx: 40_960, reason: "native_max_fits" });
  });

  it("leaves room for the background models LAX keeps loaded", () => {
    const withClassifier = chooseContext({
      gpu: RTX_5090, headroomBytes: EMBEDDER_VRAM + 4_100_000_000,
      nativeMax: 262_144, weightsBytes: WEIGHTS_27B, kvBytesPerToken: 65_536,
    });
    expect(withClassifier.numCtx).toBe(114_688);
  });

  it("never sizes up without a VRAM figure", () => {
    expect(chooseContext({ nativeMax: 262_144, weightsBytes: WEIGHTS_27B, kvBytesPerToken: 65_536, gpu: null, headroomBytes: 0 }))
      .toEqual({ numCtx: null, reason: "gpu_unknown", estimatedBytes: null, budgetBytes: null });
  });

  it("keeps the runtime default when model facts are missing", () => {
    expect(chooseContext({ ...base, nativeMax: 262_144, weightsBytes: null, kvBytesPerToken: 65_536 }).reason).toBe("model_info_incomplete");
    expect(chooseContext({ ...base, nativeMax: null, weightsBytes: WEIGHTS_27B, kvBytesPerToken: 65_536 }).reason).toBe("model_info_incomplete");
  });

  it("keeps the runtime default below the floor", () => {
    expect(chooseContext({ ...base, nativeMax: 8_192, weightsBytes: 1e9, kvBytesPerToken: 1000 }))
      .toMatchObject({ numCtx: null, reason: "native_below_floor" });
    const small = { name: "GTX", totalBytes: 12 * 1024 ** 3, source: "measured" as const };
    expect(chooseContext({ gpu: small, headroomBytes: 0, nativeMax: 262_144, weightsBytes: WEIGHTS_27B, kvBytesPerToken: 65_536 }))
      .toMatchObject({ numCtx: null, reason: "gpu_too_small" });
  });

  it("never exceeds the native window, never goes under the floor", () => {
    for (const total of [16, 24, 32, 48, 80, 192]) {
      const gpu = { name: "g", totalBytes: total * 1024 ** 3, source: "measured" as const };
      const c = chooseContext({ gpu, headroomBytes: 0, nativeMax: 262_144, weightsBytes: WEIGHTS_27B, kvBytesPerToken: 65_536 });
      if (c.numCtx !== null) {
        expect(c.numCtx).toBeLessThanOrEqual(262_144);
        expect(c.numCtx).toBeGreaterThanOrEqual(CONTEXT_FLOOR);
      }
    }
  });
});

describe("residency observation helpers", () => {
  const ps = {
    models: [
      { name: "qwen3.6:27b", model: "qwen3.6:27b", size: 33_200_000_000, size_vram: 28_400_000_000, context_length: 262_144 },
      { name: "mxbai-embed-large:latest", size: 618_387_209, size_vram: 618_387_209 },
    ],
  };

  it("parses /api/ps rows and matches the default tag", () => {
    const rows = parsePsRows(ps)!;
    expect(rows).toHaveLength(2);
    expect(findPsRow(rows, "mxbai-embed-large")?.sizeVramBytes).toBe(618_387_209);
    expect(findPsRow(rows, "qwen3.6:27b")?.contextLength).toBe(262_144);
    expect(parsePsRows({ nope: 1 })).toBeNull();
  });

  it("counts a real spill and ignores a sliver kept host-side", () => {
    const rows = parsePsRows(ps)!;
    expect(spillBytes(rows[0])).toBe(4_800_000_000);
    expect(spillBytes({ name: "m", sizeBytes: 20e9, sizeVramBytes: 20e9 - 50e6, contextLength: 1 })).toBe(0);
  });

  it("steps down by the spill's worth of KV in one move, at least a notch", () => {
    // The measured 262k spill: 4.8 GB over. One decisive step, not 8k at a time.
    expect(steppedDownContext(262_144, 4_800_000_000, 65_536)).toBe(188_416);
    expect(steppedDownContext(65_536, 1, 65_536)).toBe(57_344);
    expect(steppedDownContext(CONTEXT_FLOOR, 1e9, 65_536)).toBeNull();
  });
});
