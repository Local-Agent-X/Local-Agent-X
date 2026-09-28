import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetContextSizingForTests, appliedContext, contextSizingRecord, ensureContextDecision, sizingKey, type SizingDeps,
} from "./context-sizing.js";
import { ContextSizingStore } from "./context-sizing-store.js";
import { fakeFetchJson, referenceRuntime, RTX_5090, type FakeRuntimeState } from "./context-sizing.test-helper.js";
import { getLocalModel, getLocalModelCapabilityProfile, invalidateLocalRuntimes, restoreProjectedLocalRuntime } from "./cache.js";
import { resolveContextWindow } from "../context-manager/model-windows.js";
import type { GpuMemory } from "./context-sizing-core.js";

const ROOT = "http://127.0.0.1:11434";
let dir: string;
let state: FakeRuntimeState;
let gpu: GpuMemory | null;
let gpuReads: number;
let background: string[];

function deps(): Partial<SizingDeps> {
  return {
    fetchJson: fakeFetchJson(state),
    gpu: async () => { gpuReads++; return gpu; },
    // The default file (LAX_DATA_DIR is `dir`): the sync reader uses it too.
    store: new ContextSizingStore(join(dir, "local-context-sizing.json")),
    backgroundModels: async () => background,
    kvCacheType: () => null,
    now: () => 1_000_000,
  };
}

/** A new process: memory gone, the persisted file kept. */
function restart(): void {
  _resetContextSizingForTests();
  state.calls.length = 0;
  gpuReads = 0;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-sizing-"));
  process.env.LAX_DATA_DIR = dir;
  state = referenceRuntime();
  gpu = RTX_5090;
  gpuReads = 0;
  background = ["mxbai-embed-large"];
  _resetContextSizingForTests();
});

afterEach(() => {
  delete process.env.LAX_DATA_DIR;
  invalidateLocalRuntimes();
  rmSync(dir, { recursive: true, force: true });
});

describe("ensureContextDecision", () => {
  it("sizes the 27B to what its GPU holds and every reader gets that one number", async () => {
    const record = await ensureContextDecision(ROOT, "qwen3.6:27b", { deps: deps() });
    expect(record).toMatchObject({
      numCtx: 172_032, reason: "fits_gpu", nativeMax: 262_144, kvBytesPerToken: 65_536,
      headroomBytes: 618_387_209, verification: "pending", gpu: RTX_5090,
    });
    expect(appliedContext(ROOT, "qwen3.6:27b")).toBe(172_032);
    // config.ollamaUrl spells it "localhost", the chat base carries /v1: one endpoint.
    expect(appliedContext("http://localhost:11434/v1", "qwen3.6:27b")).toBe(172_032);
  });

  it("gives the 8B its whole native window", async () => {
    expect((await ensureContextDecision(ROOT, "qwen3:8b", { deps: deps() }))?.numCtx).toBe(40_960);
  });

  it("reuses the persisted decision in a new process without re-reading the model", async () => {
    await ensureContextDecision(ROOT, "qwen3.6:27b", { deps: deps() });
    restart();
    // Before any decide runs, a warm already gets the persisted size.
    expect(appliedContext(ROOT, "qwen3.6:27b")).toBe(172_032);
    const again = await ensureContextDecision(ROOT, "qwen3.6:27b", { deps: deps() });
    expect(again?.numCtx).toBe(172_032);
    expect(state.calls).toEqual(["/api/version", "/api/tags"]);
  });

  it.each([
    ["a new model digest", () => { state.models[0].digest = "sha256:27b-v2"; }],
    ["a new runtime version", () => { state.version = "0.35.0"; }],
    ["a different GPU", () => { gpu = { name: "NVIDIA RTX PRO 6000", totalBytes: 96 * 1024 ** 3, source: "measured" }; }],
    ["a different set of background models", () => { background = []; }],
  ])("re-decides on %s", async (_label, change) => {
    await ensureContextDecision(ROOT, "qwen3.6:27b", { deps: deps() });
    restart();
    change();
    await ensureContextDecision(ROOT, "qwen3.6:27b", { deps: deps() });
    expect(state.calls).toContain("/api/show");
  });

  it("the new GPU gets its own answer: a 96 GB card runs the native window", async () => {
    gpu = { name: "NVIDIA RTX PRO 6000", totalBytes: 96 * 1024 ** 3, source: "measured" };
    expect(await ensureContextDecision(ROOT, "qwen3.6:27b", { deps: deps() }))
      .toMatchObject({ numCtx: 262_144, reason: "native_max_fits" });
  });

  it("never sizes up on unknown VRAM", async () => {
    gpu = null;
    expect(await ensureContextDecision(ROOT, "qwen3.6:27b", { deps: deps() }))
      .toMatchObject({ numCtx: null, reason: "gpu_unknown" });
    expect(appliedContext(ROOT, "qwen3.6:27b")).toBeUndefined();
  });

  it("does not use this machine's GPU for a runtime on another machine", async () => {
    const lan = "http://192.168.1.50:11434";
    expect(await ensureContextDecision(lan, "qwen3.6:27b", { deps: deps() }))
      .toMatchObject({ numCtx: null, reason: "remote_runtime" });
    expect(gpuReads).toBe(0);
    expect(state.calls).not.toContain("/api/show");
  });

  it("decides nothing for a model the runtime does not have", async () => {
    expect(await ensureContextDecision(ROOT, "missing:1b", { deps: deps() })).toBeNull();
    expect(appliedContext(ROOT, "missing:1b")).toBeUndefined();
  });

  it("keeps the default when the runtime does not describe the architecture", async () => {
    state.models[0].info = {};
    expect(await ensureContextDecision(ROOT, "qwen3.6:27b", { deps: deps() }))
      .toMatchObject({ numCtx: null, reason: "model_info_incomplete" });
  });

  it("bounds the wait: a slow runtime is sized for the next turn, not this one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = deps();
    const inner = slow.fetchJson!;
    slow.fetchJson = async (url, init) => { await gate; return inner(url, init); };
    expect(await ensureContextDecision(ROOT, "qwen3.6:27b", { deps: slow, waitMs: 5 })).toBeNull();
    release();
    await expect.poll(() => appliedContext(ROOT, "qwen3.6:27b")).toBe(172_032);
  });
});

describe("the reported window is the applied one", () => {
  it("cache, capability profile and resolveContextWindow all read the applied size", async () => {
    const file = join(dir, "runtime.json");
    writeFileSync(file, JSON.stringify({
      kind: "ollama", id: "ollama@127.0.0.1:11434", label: "Ollama",
      endpoint: { baseUrl: ROOT, origin: "auto" }, chatBaseUrl: `${ROOT}/v1`,
      // Discovery saw it loaded at Ollama's own default before LAX sized it.
      models: [{ id: "qwen3.6:27b", contextWindow: 65_536, tools: true }], refreshedAt: 1,
    }));
    restoreProjectedLocalRuntime(file);
    expect(resolveContextWindow("qwen3.6:27b")).toEqual({ tokens: 65_536, provenance: "probed" });

    await ensureContextDecision(ROOT, "qwen3.6:27b", { deps: deps() });
    expect(getLocalModel(`${ROOT}/v1`, "qwen3.6:27b")?.contextWindow).toBe(172_032);
    expect(getLocalModelCapabilityProfile(`${ROOT}/v1`, "qwen3.6:27b").contextWindow).toBe(172_032);
    expect(resolveContextWindow("qwen3.6:27b")).toEqual({ tokens: 172_032, provenance: "probed" });
    expect(contextSizingRecord(ROOT, "qwen3.6:27b")?.key).toBe(sizingKey(ROOT, "qwen3.6:27b"));
  });
});
