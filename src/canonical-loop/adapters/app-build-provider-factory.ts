/**
 * The in-canonical app build's default provider adapter: which canonical
 * adapter a build sub-agent runs on for the user's selected provider. Split
 * out of app-build-adapter.ts at the 400-LOC gate; the adapter takes it as
 * the default for its `providerAdapterFactory` test seam.
 */
import type { Adapter } from "../adapter-contract.js";
import type { ProviderAdapterFactoryOptions } from "./app-build-adapter.js";
import { createAnthropicAdapter, type AnthropicTransport } from "./anthropic.js";

export async function defaultProviderAdapterFactory(
  provider: string,
  opts: ProviderAdapterFactoryOptions,
): Promise<Adapter> {
  if (provider === "anthropic" || provider === "anthropic-api") {
    // The API-key entry pins the key the user saved in LAX; the transport
    // must never substitute a subscription token the box also holds.
    let transport: AnthropicTransport | undefined;
    if (provider === "anthropic-api") {
      const { resolveCredential } = await import("../../auth/resolve.js");
      const { defaultAnthropicTransport } = await import("./anthropic-transport.js");
      const credential = await resolveCredential("anthropic-api");
      if (!credential) throw new Error("provider anthropic-api has no saved ANTHROPIC_API_KEY — add it in Settings");
      transport = defaultAnthropicTransport({ credential: credential.credential, source: credential.source });
    }
    return createAnthropicAdapter({
      systemPrompt: opts.systemPrompt,
      model: opts.model,
      sessionId: opts.sessionId,
      transport,
      // In-canonical builds run tool-by-tool through LAX's loop; route Claude
      // inference over the direct-HTTP OAuth path so a build never spawns the
      // `claude` CLI per turn (that's the whole point of the no-CLI strategy).
      // Falls back to the CLI proxy automatically if no direct token resolves.
      preferDirectHttp: true,
    });
  }
  if (provider === "codex") {
    const { createCodexAdapter } = await import("./codex.js");
    return createCodexAdapter({
      systemPrompt: opts.systemPrompt,
      model: opts.model,
      sessionId: opts.sessionId,
    });
  }
  // openai-compat: qwen / cerebras / grok / gemini / local / openai / xai / custom / ollama-cloud
  const { createOpenAICompatAdapter, resolveOpenAICompatTarget } = await import("./openai-compat.js");
  const { resolveProvider } = await import("../../agent-request/resolve-provider.js");
  const { getRuntimeConfig } = await import("../../config.js");
  const { getOrInitSecretsStore } = await import("../../secrets.js");
  const { getLaxDir } = await import("../../lax-data-dir.js");
  const dataDir = getLaxDir();
  const config = getRuntimeConfig();
  const secrets = getOrInitSecretsStore(dataDir);
  const prepared = await resolveProvider(config, secrets, dataDir, provider);
  // Local per-model routing (Turbo cloud override, LM Studio/vLLM/llama.cpp
  // runtime lookup) lives inside resolveOpenAICompatTarget — one seam.
  const target = await resolveOpenAICompatTarget(
    prepared.provider,
    { apiKey: prepared.apiKey, customBaseURL: prepared.customBaseURL },
    opts.model ?? prepared.model,
  );
  if (!target) {
    throw new Error(`provider ${provider} has no usable OpenAI-compat target — check API key and base URL config`);
  }
  return createOpenAICompatAdapter({
    systemPrompt: opts.systemPrompt,
    model: opts.model ?? prepared.model,
    baseURL: target.baseURL,
    apiKey: target.apiKey,
    temperature: prepared.temperature,
    sessionId: opts.sessionId,
  });
}
