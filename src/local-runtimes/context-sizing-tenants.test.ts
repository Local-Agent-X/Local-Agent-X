import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetContextSizingForTests, appliedContext, contextSizingRecord, ensureContextDecision } from "./context-sizing.js";
import { CONTENTION_COOLDOWN_MS, observeChatResidency } from "./context-sizing-adapt.js";
import { estimateResidentBytes } from "./context-sizing-core.js";
import { ContextSizingStore } from "./context-sizing-store.js";
import { CHECK_EVERY_MS, _resetTenantChecksForTests, fitAroundOtherPrograms } from "./context-sizing-tenants.js";
import { EMBEDDER_VRAM, fakeFetchJson, referenceRuntime, RTX_5090 } from "./context-sizing.test-helper.js";

const ROOT = "http://127.0.0.1:11434";
const MODEL = "qwen3.6:27b";
const GIB = 1024 ** 3;
let dir: string;
let now: number;
let sized: number;

const embedder = { name: "mxbai-embed-large:latest", size: EMBEDDER_VRAM, size_vram: EMBEDDER_VRAM };

/** The driver's reading with `others` bytes held by programs outside Ollama
 *  and the given models loaded (the chat model at its estimated footprint). */
async function check(others: number, rows: Array<{ name: string; size: number; size_vram: number; context_length?: number }>): Promise<void> {
  const record = contextSizingRecord(ROOT, MODEL)!;
  const ollama = rows.reduce((sum, r) => sum + (r.name === MODEL
    ? estimateResidentBytes(record.weightsBytes!, record.kvBytesPerToken!, r.context_length ?? 0)
    : r.size_vram), 0);
  await fitAroundOtherPrograms(ROOT, MODEL, { ps: async () => ({ models: rows }), gpuUsed: async () => ollama + others, now: () => now });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "lax-tenants-"));
  process.env.LAX_DATA_DIR = dir;
  now = 5_000_000;
  _resetContextSizingForTests();
  _resetTenantChecksForTests();
  await ensureContextDecision(ROOT, MODEL, {
    deps: {
      fetchJson: fakeFetchJson(referenceRuntime()),
      gpu: async () => RTX_5090,
      store: new ContextSizingStore(join(dir, "local-context-sizing.json")),
      backgroundModels: async () => ["mxbai-embed-large"],
      kvCacheType: () => null,
      now: () => now,
    },
  });
  sized = appliedContext(ROOT, MODEL)!;
});

afterEach(() => {
  delete process.env.LAX_DATA_DIR;
  _resetContextSizingForTests();
  _resetTenantChecksForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("fitAroundOtherPrograms", () => {
  it("leaves the decided size alone when the desktop and a browser fit in the margin", async () => {
    await check(1.5 * GIB, [embedder]);
    expect(appliedContext(ROOT, MODEL)).toBe(sized);
  });

  it("runs smaller while a voice engine holds more than the margin, before the model loads (live 2026-11-18)", async () => {
    // VoxCPM 5.6 GB, the Lite sidecar and the desktop: about 8 GB outside Ollama.
    await check(8 * GIB, [embedder]);
    const reduced = appliedContext(ROOT, MODEL)!;
    expect(reduced).toBeLessThan(sized);
    expect(contextSizingRecord(ROOT, MODEL)?.numCtx).toBe(sized); // the decision itself is untouched
    // What it chose fits beside them: weights + KV + the others + slack on the card.
    const record = contextSizingRecord(ROOT, MODEL)!;
    expect(estimateResidentBytes(record.weightsBytes!, record.kvBytesPerToken!, reduced) + EMBEDDER_VRAM + 8 * GIB + GIB)
      .toBeLessThanOrEqual(RTX_5090.totalBytes);
  });

  it("measures the others with the chat model loaded, from the estimate and not Ollama's low figure for it", async () => {
    // /api/ps reports the 27B at 18 GB while it holds its whole estimate.
    await check(1.5 * GIB, [{ name: MODEL, size: 18e9, size_vram: 18e9, context_length: sized }, embedder]);
    expect(appliedContext(ROOT, MODEL)).toBe(sized);
  });

  it("reads the card at most once per interval", async () => {
    await check(1.5 * GIB, [embedder]);
    now += CHECK_EVERY_MS - 1;
    await check(8 * GIB, [embedder]);
    expect(appliedContext(ROOT, MODEL)).toBe(sized);
    now += 1;
    await check(8 * GIB, [embedder]);
    expect(appliedContext(ROOT, MODEL)).toBeLessThan(sized);
  });

  it("does nothing without a driver reading", async () => {
    await fitAroundOtherPrograms(ROOT, MODEL, { ps: async () => ({ models: [embedder] }), gpuUsed: async () => null, now: () => now });
    expect(appliedContext(ROOT, MODEL)).toBe(sized);
  });

  it("goes back to the decided size once the voice engine is gone, after the cooldown", async () => {
    await check(8 * GIB, [embedder]);
    const reduced = appliedContext(ROOT, MODEL)!;
    const record = contextSizingRecord(ROOT, MODEL)!;
    const atReduced = estimateResidentBytes(record.weightsBytes!, record.kvBytesPerToken!, reduced);
    const reply = (others: number) => observeChatResidency(ROOT, MODEL, {
      ps: async () => ({ models: [{ name: MODEL, size: atReduced, size_vram: atReduced, context_length: reduced }, embedder] }),
      gpuUsed: async () => atReduced + EMBEDDER_VRAM + others,
      runnerShared: async () => null,
      now: () => now,
      store: new ContextSizingStore(join(dir, "local-context-sizing.json")),
    });
    await reply(8 * GIB);
    now += CONTENTION_COOLDOWN_MS;
    await reply(8 * GIB);
    expect(appliedContext(ROOT, MODEL)).toBe(reduced); // still there: stays small
    await reply(1 * GIB);
    now += CONTENTION_COOLDOWN_MS;
    await reply(1 * GIB);
    expect(appliedContext(ROOT, MODEL)).toBe(sized);
  });
});
