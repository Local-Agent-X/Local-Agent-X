import { registerAdapterForOp } from "../runtime.js";
import { createAnthropicAdapter } from "../adapters/anthropic.js";
import type { CanonicalAgentOptions } from "./types.js";

export async function registerProviderAdapter(
  opId: string,
  options: CanonicalAgentOptions,
  sessionId: string,
): Promise<void> {
  const { provider, model, systemPrompt, temperature, apiKey } = options;

  if (provider === "anthropic") {
    registerAdapterForOp(opId, () =>
      createAnthropicAdapter({ systemPrompt, model, sessionId }),
    );
    return;
  }
  if (provider === "codex") {
    const { createCodexAdapter } = await import("../adapters/codex.js");
    registerAdapterForOp(opId, () =>
      createCodexAdapter({ systemPrompt, model, sessionId }),
    );
    return;
  }
  // Gemini → native generateContent adapter (the compat shim empties on
  // tool-laden requests; see gemini-native.ts). Same key resolution, native wire.
  if (provider === "gemini") {
    const { resolveOpenAICompatTarget } = await import("../adapters/openai-compat.js");
    const target = await resolveOpenAICompatTarget("gemini", { apiKey, customBaseURL: options.baseURL });
    if (!target) {
      throw new Error("gemini has no usable target — check API key config");
    }
    const { createGeminiNativeAdapter } = await import("../adapters/gemini-native.js");
    registerAdapterForOp(opId, () =>
      createGeminiNativeAdapter({
        model,
        apiKey: target.apiKey,
        systemPrompt,
        temperature,
        thinking: /gemini-(2\.5|3)/i.test(model),
        sessionId,
      }),
    );
    return;
  }

  const { createOpenAICompatAdapter, resolveOpenAICompatTarget } = await import("../adapters/openai-compat.js");
  // Local per-model routing (Turbo cloud override, LM Studio/vLLM/llama.cpp
  // runtime lookup) lives inside resolveOpenAICompatTarget — one seam.
  const target = await resolveOpenAICompatTarget(provider, { apiKey, customBaseURL: options.baseURL }, model);
  if (!target) {
    throw new Error(`provider ${provider} has no usable OpenAI-compat target — check API key and base URL config`);
  }
  const finalTarget = target;
  // Ollama (local + cloud) reports model capabilities via /api/show. Probe once
  // up front so a tool-less local model is recorded in the registry before the
  // first turn, rather than discovered via the empty-response stumble. Bounded,
  // fail-safe, and cached per (baseURL, model) — a no-op for non-Ollama.
  if (provider === "local" || provider === "ollama-cloud") {
    const { probeOllamaCapabilities } = await import("../../providers/ollama-capability-probe.js");
    await probeOllamaCapabilities(finalTarget.baseURL, model, finalTarget.apiKey);
  }
  registerAdapterForOp(opId, () =>
    createOpenAICompatAdapter({
      systemPrompt,
      model,
      baseURL: finalTarget.baseURL,
      apiKey: finalTarget.apiKey,
      temperature,
      sessionId,
      // Spawned field agents are expected to act. Force a real tool call on
      // turn 0 so weaker OpenAI-compat models (xAI Grok) can't open by
      // narrating the call as prose instead of emitting it. Turn-0 only;
      // the openai-compat adapter releases the pin afterward.
      requireToolOnFirstTurn: true,
    }),
  );
}
