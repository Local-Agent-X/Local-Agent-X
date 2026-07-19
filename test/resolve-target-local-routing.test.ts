import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  localModelEvidenceForResolvedTarget,
  resolveOpenAICompatTarget,
} from "../src/canonical-loop/adapters/openai-compat/resolve-target.js";
import { resolveBackgroundModel } from "../src/providers/background-model.js";
import type { LocalRuntimeInfo } from "../src/local-runtimes/types.js";

const LMSTUDIO_RT: LocalRuntimeInfo = {
  kind: "openai-compat",
  id: "openai-compat@127.0.0.1:1234",
  label: "LM Studio",
  endpoint: { baseUrl: "http://127.0.0.1:1234", origin: "auto" },
  chatBaseUrl: "http://127.0.0.1:1234/v1",
  models: [{ id: "google/gemma-4-e4b", contextWindow: null, tools: true }],
  refreshedAt: 1,
};

let runtimes: LocalRuntimeInfo[] | null = [LMSTUDIO_RT];
let cloudModels = new Set<string>();
let certifiedBackgroundModel: string | null = null;
let discoveredBackgroundModel: string | null = null;

vi.mock("../src/config.js", () => ({
  getRuntimeConfig: () => ({ ollamaUrl: "http://127.0.0.1:11434" }),
}));
vi.mock("../src/local-runtimes/index.js", () => ({
  getLocalRuntimes: () => runtimes,
  pickCertifiedLocalClassifierModel: () => certifiedBackgroundModel,
  pickLocalClassifierModel: () => discoveredBackgroundModel,
  getRuntimeForModel: (m: string) =>
    runtimes?.find(r => r.models.some(x => x.id === m)) ?? null,
  getLocalModelCapabilityProfile: (baseURL: string, model: string) => {
    const runtime = runtimes?.find(r => r.chatBaseUrl === baseURL) ?? null;
    const localModel = runtime?.models.find(candidate => candidate.id === model) ?? null;
    return {
      runtimeId: runtime?.id ?? null,
      baseURL,
      model,
      tier: "medium",
      maxTools: 24,
      contextWindow: localModel?.contextWindow ?? null,
      tools: {
        advertised: localModel?.tools ?? null,
        verified: null,
        rejectsTools: false,
      },
    };
  },
  refreshLocalRuntimes: vi.fn(async () => {
    runtimes = [LMSTUDIO_RT];
    return runtimes;
  }),
}));
vi.mock("../src/ollama-cloud.js", () => ({
  isCloudModel: (m: string) => cloudModels.has(m),
  getCloudOllamaCallTarget: () => ({ baseURL: "https://cloud.example/v1", apiKey: "ck" }),
}));

beforeEach(() => {
  runtimes = [LMSTUDIO_RT];
  cloudModels = new Set();
  certifiedBackgroundModel = null;
  discoveredBackgroundModel = null;
});

describe("resolveOpenAICompatTarget local per-model routing", () => {
  it("routes an LM Studio model to LM Studio's /v1, not ollamaUrl", async () => {
    const t = await resolveOpenAICompatTarget("local", { apiKey: "" }, "google/gemma-4-e4b");
    expect(t).toMatchObject({
      baseURL: "http://127.0.0.1:1234/v1",
      apiKey: "ollama",
      modelProfile: { runtimeId: LMSTUDIO_RT.id, model: "google/gemma-4-e4b" },
    });
  });

  it("falls back to config.ollamaUrl for a model no runtime claims (pre-seam behavior)", async () => {
    const t = await resolveOpenAICompatTarget("local", { apiKey: "" }, "qwen2:7b");
    expect(t).toMatchObject({
      baseURL: "http://127.0.0.1:11434/v1",
      apiKey: "ollama",
      modelProfile: {
        runtimeId: null,
        model: "qwen2:7b",
        contextWindow: null,
        tools: { advertised: null, verified: null, rejectsTools: false },
      },
    });
    expect(localModelEvidenceForResolvedTarget("local", t!)).toMatchObject({
      runtimeId: null,
      baseURL: "http://127.0.0.1:11434/v1",
      model: "qwen2:7b",
    });
  });

  it("cloud (Turbo) models still override to the cloud target", async () => {
    cloudModels.add("google/gemma-4-e4b");
    const t = await resolveOpenAICompatTarget("local", { apiKey: "" }, "google/gemma-4-e4b");
    expect(t).toEqual({ baseURL: "https://cloud.example/v1", apiKey: "ck" });
    expect(localModelEvidenceForResolvedTarget("local", t!)).toBeNull();
  });

  it("derives capability evidence only from the exact resolved local target", async () => {
    const local = await resolveOpenAICompatTarget("local", { apiKey: "" }, "google/gemma-4-e4b");
    expect(localModelEvidenceForResolvedTarget("local", local!)).toMatchObject({
      runtimeId: LMSTUDIO_RT.id,
      baseURL: LMSTUDIO_RT.chatBaseUrl,
      model: "google/gemma-4-e4b",
    });
    expect(localModelEvidenceForResolvedTarget("openai", local!)).toBeNull();
  });

  it("boot race: null cache triggers ONE awaited sweep, then routes correctly", async () => {
    runtimes = null;
    const t = await resolveOpenAICompatTarget("local", { apiKey: "" }, "google/gemma-4-e4b");
    expect(t).toMatchObject({
      baseURL: "http://127.0.0.1:1234/v1",
      apiKey: "ollama",
      modelProfile: { runtimeId: LMSTUDIO_RT.id, model: "google/gemma-4-e4b" },
    });
    const { refreshLocalRuntimes } = await import("../src/local-runtimes/index.js");
    expect(vi.mocked(refreshLocalRuntimes)).toHaveBeenCalledTimes(1);
  });

  it("no model arg → old behavior exactly (ollamaUrl)", async () => {
    const t = await resolveOpenAICompatTarget("local", { apiKey: "" });
    expect(t).toEqual({ baseURL: "http://127.0.0.1:11434/v1", apiKey: "ollama" });
  });

  it("keeps duplicate-ID fallback on the canonical first runtime when no cert can select safely", async () => {
    const first: LocalRuntimeInfo = {
      ...LMSTUDIO_RT,
      id: "openai-compat@127.0.0.1:1001",
      endpoint: { baseUrl: "http://127.0.0.1:1001", origin: "auto" },
      chatBaseUrl: "http://127.0.0.1:1001/v1",
      models: [{ id: "shared:3b", contextWindow: 8192, tools: true, sizeBytes: 3e9 }],
    };
    const second: LocalRuntimeInfo = {
      ...LMSTUDIO_RT,
      id: "openai-compat@127.0.0.1:1002",
      endpoint: { baseUrl: "http://127.0.0.1:1002", origin: "auto" },
      chatBaseUrl: "http://127.0.0.1:1002/v1",
      models: [{ id: "shared:3b", contextWindow: 8192, tools: true, sizeBytes: 3e9 }],
    };
    runtimes = [first, second];
    discoveredBackgroundModel = "shared:3b";
    expect(await resolveBackgroundModel("local", "chat:27b")).toBe("shared:3b");
    expect(await resolveOpenAICompatTarget("local", { apiKey: "" }, "shared:3b")).toMatchObject({
      baseURL: first.chatBaseUrl,
      modelProfile: { runtimeId: first.id },
    });
  });
});
