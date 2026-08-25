/**
 * Chat-side residency wiring: resolving a "local" chat target against an
 * Ollama-NATIVE runtime must engage holdChatModelResidency (the /v1 chat
 * endpoint ignores keep_alive, so without the hold the chat model idles out
 * on Ollama's 5m default and every post-idle turn pays a 30-60s cold load).
 * OpenAI-compat-only runtimes (LM Studio, vLLM) must NOT be held — the hold
 * rides /api/generate, which they don't serve.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { resolveOpenAICompatTarget } from "./resolve-target.js";

const holdChatModelResidency = vi.fn();

vi.mock("../../../local-runtimes/residency.js", () => ({
  holdChatModelResidency: (...args: unknown[]) => holdChatModelResidency(...args),
}));

const runtimeForModel: { value: unknown } = { value: null };

vi.mock("../../../local-runtimes/index.js", () => ({
  getLocalModelCapabilityProfile: () => null,
  getRuntimeForModel: () => runtimeForModel.value,
  getLocalRuntimes: () => [],
  refreshLocalRuntimes: async () => {},
}));

vi.mock("../../../ollama-cloud.js", () => ({
  isCloudModel: () => false,
  getCloudOllamaCallTarget: () => null,
}));

vi.mock("../../../config.js", () => ({
  getRuntimeConfig: () => ({ ollamaUrl: "http://127.0.0.1:11434" }),
}));

beforeEach(() => {
  holdChatModelResidency.mockClear();
  runtimeForModel.value = null;
});

describe("resolve-target chat residency", () => {
  it("holds the chat model on an Ollama-native runtime, using the native root", async () => {
    runtimeForModel.value = {
      kind: "ollama",
      endpoint: { baseUrl: "http://127.0.0.1:11434", origin: "auto" },
      chatBaseUrl: "http://127.0.0.1:11434/v1",
    };
    const target = await resolveOpenAICompatTarget("local", { apiKey: "" }, "qwen3.6:27b");
    expect(target?.baseURL).toBe("http://127.0.0.1:11434/v1");
    expect(holdChatModelResidency).toHaveBeenCalledWith("http://127.0.0.1:11434", "qwen3.6:27b");
  });

  it("never holds an openai-compat runtime — no /api/generate to warm through", async () => {
    runtimeForModel.value = {
      kind: "openai-compat",
      endpoint: { baseUrl: "http://127.0.0.1:1234", origin: "auto" },
      chatBaseUrl: "http://127.0.0.1:1234/v1",
    };
    const target = await resolveOpenAICompatTarget("local", { apiKey: "" }, "some-lmstudio-model");
    expect(target?.baseURL).toBe("http://127.0.0.1:1234/v1");
    expect(holdChatModelResidency).not.toHaveBeenCalled();
  });

  it("holds via config.ollamaUrl on the pre-seam fallback path", async () => {
    // No discovered runtime serves the model → resolve falls through to the
    // registry baseURL derived from config.ollamaUrl, which is Ollama-native.
    const target = await resolveOpenAICompatTarget("local", { apiKey: "" }, "qwen3.6:27b");
    expect(target).not.toBeNull();
    expect(holdChatModelResidency).toHaveBeenCalledWith("http://127.0.0.1:11434", "qwen3.6:27b");
  });
});
