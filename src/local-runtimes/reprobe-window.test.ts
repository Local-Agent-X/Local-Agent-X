import { describe, it, expect, beforeEach, vi } from "vitest";

// Live failure 2026-09-08 (qwen3.6:27b, Ollama): discovery ran while the model
// was unloaded, so /api/ps had no entry and the window was recorded as null.
// Nothing ever revisited it, so every turn sized against the 8,192 floor while
// the model was actually serving 65,536 — the UI read "246% context 20K / 8K".
// It corrected only when an unrelated sweep happened to land while the model
// was loaded, which is a race rather than a mechanism.
const probeModel = vi.fn();

vi.mock("./probes.js", () => ({
  LOCAL_RUNTIME_PROBES: [
    {
      kind: "ollama",
      label: "Ollama",
      defaultPorts: [11434],
      detect: async () => true,
      listModels: async () => [],
      probeModel: (...args: unknown[]) => probeModel(...args),
    },
  ],
}));

const CHAT = "http://127.0.0.1:11434/v1";

async function seedCache(contextWindow: number | null) {
  const cache = await import("./cache.js");
  cache.invalidateLocalRuntimes();
  const discovery = await import("./discovery.js");
  vi.spyOn(discovery, "discoverLocalRuntimes").mockResolvedValue([
    {
      kind: "ollama",
      id: "ollama@127.0.0.1:11434",
      label: "Ollama",
      endpoint: { baseUrl: "http://127.0.0.1:11434", kind: "ollama" },
      chatBaseUrl: CHAT,
      models: [{ id: "qwen3.6:27b", contextWindow, tools: null }],
    },
  ] as unknown as Awaited<ReturnType<typeof discovery.discoverLocalRuntimes>>);
  await cache.refreshLocalRuntimes();
  return cache;
}

describe("re-probing a local model whose window is unknown", () => {
  beforeEach(() => {
    probeModel.mockReset();
    vi.restoreAllMocks();
  });

  it("asks the runtime again and adopts the served window", async () => {
    const cache = await seedCache(null);
    expect(cache.getLocalContextWindow(CHAT, "qwen3.6:27b")).toBeNull();

    probeModel.mockResolvedValue({ contextWindow: 65_536 });
    await expect(cache.reprobeLocalModelWindow(CHAT, "qwen3.6:27b")).resolves.toBe(65_536);
    expect(cache.getLocalContextWindow(CHAT, "qwen3.6:27b")).toBe(65_536);
  });

  it("does not ask again once the window is known", async () => {
    const cache = await seedCache(65_536);
    await cache.reprobeLocalModelWindow(CHAT, "qwen3.6:27b");
    expect(probeModel).not.toHaveBeenCalled();
  });

  it("coalesces concurrent callers into one probe", async () => {
    const cache = await seedCache(null);
    probeModel.mockResolvedValue({ contextWindow: 65_536 });
    const all = await Promise.all([
      cache.reprobeLocalModelWindow(CHAT, "qwen3.6:27b"),
      cache.reprobeLocalModelWindow(CHAT, "qwen3.6:27b"),
      cache.reprobeLocalModelWindow(CHAT, "qwen3.6:27b"),
    ]);
    expect(all).toEqual([65_536, 65_536, 65_536]);
    expect(probeModel).toHaveBeenCalledTimes(1);
  });

  it("stays unknown when the model is still not loaded", async () => {
    const cache = await seedCache(null);
    probeModel.mockResolvedValue({});
    await expect(cache.reprobeLocalModelWindow(CHAT, "qwen3.6:27b")).resolves.toBeNull();
    expect(cache.getLocalContextWindow(CHAT, "qwen3.6:27b")).toBeNull();
  });

  it("never lets a probe failure break the turn", async () => {
    const cache = await seedCache(null);
    probeModel.mockRejectedValue(new Error("connection refused"));
    await expect(cache.reprobeLocalModelWindow(CHAT, "qwen3.6:27b")).resolves.toBeNull();
  });

  it("ignores a model the cache does not know", async () => {
    const cache = await seedCache(null);
    await expect(cache.reprobeLocalModelWindow(CHAT, "not-installed")).resolves.toBeNull();
    expect(probeModel).not.toHaveBeenCalled();
  });
});
