// Resolve the OpenAI-compat baseURL + apiKey for a given canonical provider
// id. Mirrors the providerURLs map in run-standard.ts so we don't drift
// while both code paths exist. Once the legacy path is removed, this
// becomes the only source of truth.
//
// Returns null when the provider isn't OpenAI-compat (anthropic/codex use
// their own adapters) or when required config is missing.

import type { OpenAICompatTarget } from "./types.js";

export async function resolveOpenAICompatTarget(
  provider: string,
  prepared: { apiKey: string; customBaseURL?: string },
  model?: string,
): Promise<OpenAICompatTarget | null> {
  const { PROVIDERS, isHttpProvider } = await import("../../../providers/registry.js");
  const { PROVIDER_IDS } = await import("../../../providers/provider-ids.js");

  if (!(PROVIDER_IDS as readonly string[]).includes(provider)) return null;
  const meta = PROVIDERS[provider as typeof PROVIDER_IDS[number]];

  // The transport discriminator is the safety belt: anthropic (cli)
  // cannot accidentally fall through to openai-compat routing.
  if (!isHttpProvider(meta)) return null;

  // Ollama Cloud keeps its own resolver because the baseURL pairs with
  // a cache-warmed apiKey (the registry returns null for it on purpose).
  if (provider === "ollama-cloud") {
    const { getCloudOllamaCallTarget } = await import("../../../ollama-cloud.js");
    return getCloudOllamaCallTarget();
  }

  // "local" routes PER MODEL — this is the one place that decides which
  // local endpoint serves a given model (previously three call sites each
  // duplicated the cloud-override half of this rule):
  //   1. Ollama Turbo models merged into the local picker → cloud target.
  //   2. The discovered runtime actually serving the model (Ollama,
  //      LM Studio, vLLM, llama.cpp — src/local-runtimes/ cache).
  //   3. config.ollamaUrl — pre-seam fallback, keeps old setups working.
  if (provider === "local" && model) {
    const { isCloudModel, getCloudOllamaCallTarget } = await import("../../../ollama-cloud.js");
    if (isCloudModel(model)) {
      const cloud = getCloudOllamaCallTarget();
      if (cloud) return cloud;
    }
    const { getRuntimeForModel, getLocalRuntimes, refreshLocalRuntimes } =
      await import("../../../local-runtimes/index.js");
    let rt = getRuntimeForModel(model);
    if (!rt && getLocalRuntimes() === null) {
      // Boot race: cache never populated. One awaited sweep, then retry —
      // without this the first post-boot turn would 404 against ollamaUrl
      // for any non-Ollama model.
      try { await refreshLocalRuntimes(); } catch { /* fall through */ }
      rt = getRuntimeForModel(model);
    }
    if (rt) return { baseURL: rt.chatBaseUrl, apiKey: prepared.apiKey || "ollama" };
  }

  const { getRuntimeConfig } = await import("../../../config.js");
  const baseURL = typeof meta.baseURL === "function"
    ? meta.baseURL({ ollamaUrl: getRuntimeConfig().ollamaUrl, customBaseURL: prepared.customBaseURL })
    : meta.baseURL;
  if (!baseURL) return null;

  // Local Ollama doesn't require an API key — fall back to the literal
  // string "ollama" the old branch used so downstream auth headers stay
  // identical to pre-registry behavior.
  const apiKey = provider === "local" ? (prepared.apiKey || "ollama") : prepared.apiKey;
  return { baseURL, apiKey };
}
