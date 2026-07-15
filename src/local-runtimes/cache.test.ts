import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  refreshLocalRuntimes,
  getLocalRuntimes,
  getLocalContextWindow,
  getRuntimeForModel,
  invalidateLocalRuntimes,
  localRuntimesStale,
} from "./cache.js";
import type { LocalRuntimeInfo } from "./types.js";

const RUNTIME: LocalRuntimeInfo = {
  kind: "ollama",
  id: "ollama@127.0.0.1:11434",
  label: "Ollama",
  endpoint: { baseUrl: "http://127.0.0.1:11434", origin: "auto" },
  chatBaseUrl: "http://127.0.0.1:11434/v1",
  models: [
    { id: "qwen3.6:27b", contextWindow: 32768, tools: true },
    { id: "mystery:latest", contextWindow: null, tools: null },
  ],
  refreshedAt: 0,
};

vi.mock("./endpoints.js", () => ({ candidateEndpoints: () => [] }));
vi.mock("./discovery.js", () => ({
  discoverLocalRuntimes: vi.fn(async () => [RUNTIME]),
}));

beforeEach(() => invalidateLocalRuntimes());

describe("local-runtime cache", () => {
  it("null before first refresh; populated + fresh after", async () => {
    expect(getLocalRuntimes()).toBeNull();
    expect(localRuntimesStale()).toBe(true);
    await refreshLocalRuntimes();
    expect(getLocalRuntimes()).toEqual([RUNTIME]);
    expect(localRuntimesStale()).toBe(false);
  });

  it("sync lookups: window by (chatBaseUrl, model); runtime by model", async () => {
    await refreshLocalRuntimes();
    expect(getLocalContextWindow("http://127.0.0.1:11434/v1", "qwen3.6:27b")).toBe(32768);
    // unknown window stays null — never an optimistic default
    expect(getLocalContextWindow("http://127.0.0.1:11434/v1", "mystery:latest")).toBeNull();
    expect(getLocalContextWindow("http://127.0.0.1:11434/v1", "absent")).toBeNull();
    expect(getRuntimeForModel("qwen3.6:27b")?.id).toBe("ollama@127.0.0.1:11434");
    expect(getRuntimeForModel("absent")).toBeNull();
  });

  it("coalesces concurrent refreshes into one sweep", async () => {
    const { discoverLocalRuntimes } = await import("./discovery.js");
    vi.mocked(discoverLocalRuntimes).mockClear();
    await Promise.all([refreshLocalRuntimes(), refreshLocalRuntimes(), refreshLocalRuntimes()]);
    expect(vi.mocked(discoverLocalRuntimes)).toHaveBeenCalledTimes(1);
  });
});
