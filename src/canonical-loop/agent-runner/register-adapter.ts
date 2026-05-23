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
  const { createOpenAICompatAdapter, resolveOpenAICompatTarget } = await import("../adapters/openai-compat.js");
  let target = await resolveOpenAICompatTarget(provider, { apiKey, customBaseURL: options.baseURL });
  if (provider === "local") {
    const { isCloudModel, getCloudOllamaCallTarget } = await import("../../ollama-cloud.js");
    if (isCloudModel(model)) {
      const cloudTarget = getCloudOllamaCallTarget();
      if (cloudTarget) target = cloudTarget;
    }
  }
  if (!target) {
    throw new Error(`provider ${provider} has no usable OpenAI-compat target — check API key and base URL config`);
  }
  const finalTarget = target;
  registerAdapterForOp(opId, () =>
    createOpenAICompatAdapter({
      systemPrompt,
      model,
      baseURL: finalTarget.baseURL,
      apiKey: finalTarget.apiKey,
      temperature,
      sessionId,
    }),
  );
}
