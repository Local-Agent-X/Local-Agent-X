import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntimeConfig, setRuntimeConfig } from "./config.js";
import type { LAXConfig } from "./types.js";
import {
  fetchLocalOllamaTags,
  getCloudOllamaCallTarget,
  isCloudModel,
  refreshCloudOllama,
} from "./ollama-cloud.js";
import { refreshTokens } from "./auth/index.js";
import { refreshAnthropicTokens } from "./auth/anthropic.js";
import { refreshXaiTokens } from "./auth/xai.js";
import { AgentSync } from "./sync/index.js";
import { LocalOnlyEmbeddingGuard } from "./embedding-providers/local-only-guard.js";
import { OllamaEmbeddings } from "./embedding-providers/ollama.js";
import { createEmbeddingProvider } from "./embedding-providers/index.js";
import { createEdgeTtsProvider } from "./voice/tier4/edge-tts-adapter.js";
import type { ExtendedEmbeddingProvider } from "./embedding-providers/types.js";

let savedConfig: LAXConfig;
const strict = (): void => setRuntimeConfig({ ...savedConfig, localOnlyMode: true });
const remote = (): void => setRuntimeConfig({ ...savedConfig, localOnlyMode: false });

describe("strict local-only internal bypass guards", () => {
  beforeAll(() => { savedConfig = getRuntimeConfig(); });
  afterAll(() => setRuntimeConfig(savedConfig));
  beforeEach(() => { strict(); vi.restoreAllMocks(); });

  it("suppresses cloud Ollama refresh and stale cloud-model substitution", async () => {
    remote();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      models: [{ name: "cloud-only:70b" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const secrets = { has: () => true, get: () => "cloud-key" } as never;
    const seeded = await refreshCloudOllama(secrets, "https://ollama.example");
    expect(seeded.reachable).toBe(true);
    expect(isCloudModel("cloud-only:70b")).toBe(true);
    strict();
    fetchSpy.mockClear();
    const result = await refreshCloudOllama(secrets, "https://ollama.example");
    expect(result.reachable).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(isCloudModel("cloud-only:70b")).toBe(false);
    expect(getCloudOllamaCallTarget()).toBeNull();
  });

  it("refuses a non-loopback Ollama endpoint before fetching tags", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(fetchLocalOllamaTags("https://ollama.example")).resolves.toEqual({ reachable: false, models: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("suppresses every OAuth refresh implementation before network access", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(refreshTokens({ accessToken: "a", refreshToken: "r", expiresAt: 0 })).rejects.toThrow(/local-only/i);
    await expect(refreshAnthropicTokens({ accessToken: "a", refreshToken: "r", expiresAt: 0, method: "oauth", provider: "anthropic" })).rejects.toThrow(/local-only/i);
    await expect(refreshXaiTokens({ accessToken: "a", refreshToken: "r", provider: "xai" })).rejects.toThrow(/local-only/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("suppresses direct Agent Sync pull and push entry points", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-local-sync-"));
    try {
      const sync = new AgentSync(dir, () => "token");
      await expect(sync.push()).resolves.toMatchObject({ success: false, message: expect.stringMatching(/local-only/i) });
      await expect(sync.pull()).resolves.toMatchObject({ success: false, message: expect.stringMatching(/local-only/i) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks an already-constructed cloud embedding provider on every call", async () => {
    const inner = {
      name: "remote", model: "remote-model", dimensions: 3, maxBatchSize: 8,
      embed: vi.fn(async () => [1, 2, 3]),
      embedQuery: vi.fn(async () => [1, 2, 3]),
      embedBatch: vi.fn(async () => [[1, 2, 3]]),
    } satisfies ExtendedEmbeddingProvider;
    const guarded = new LocalOnlyEmbeddingGuard(inner);
    await expect(guarded.embed("secret")).resolves.toEqual([0, 0, 0]);
    await expect(guarded.embedBatch(["a", "b"])).resolves.toEqual([[0, 0, 0], [0, 0, 0]]);
    expect(inner.embed).not.toHaveBeenCalled();
    expect(inner.embedBatch).not.toHaveBeenCalled();
  });

  it("validates an Ollama embedding URL before health or embed fetches", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = new OllamaEmbeddings({ baseUrl: "https://ollama.example", model: "embed-model" });
    await expect(provider.embed("text")).resolves.toEqual(expect.arrayContaining([0]));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not construct an Ollama embedding provider from a remote runtime URL", () => {
    setRuntimeConfig({ ...savedConfig, localOnlyMode: true, ollamaUrl: "https://ollama.example" });
    expect(createEmbeddingProvider({ provider: "ollama" }).name).toBe("local");
  });

  it("blocks remote edge TTS construction while strict mode is active", async () => {
    await expect(createEdgeTtsProvider({}, {})).rejects.toThrow(/local-only/i);
  });

  it("restores guarded remote embedding behavior when strict mode is disabled", async () => {
    const inner = {
      name: "remote", model: "remote-model", dimensions: 1, maxBatchSize: 1,
      embed: vi.fn(async () => [1]), embedQuery: vi.fn(async () => [1]), embedBatch: vi.fn(async () => [[1]]),
    } satisfies ExtendedEmbeddingProvider;
    const guarded = new LocalOnlyEmbeddingGuard(inner);
    remote();
    await expect(guarded.embed("ok")).resolves.toEqual([1]);
    expect(inner.embed).toHaveBeenCalledOnce();
  });
});
