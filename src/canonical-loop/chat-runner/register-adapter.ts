// Provider → adapter dispatch. Picks the right canonical adapter based on
// prepared.provider and registers it for the op. Three branches:
//   - anthropic   → AnthropicAdapter (CLI transport)
//   - codex       → CodexAdapter
//   - everything else → OpenAICompatAdapter (one wire shape, swapped
//     baseURL+apiKey per provider). For "local" we additionally check the
//     per-model cloud-Ollama set, so picking a Turbo model from inside
//     the local dropdown still routes to the cloud endpoint.

import type { PreparedAgentRequest } from "../../agent-request/types.js";
import { registerAdapterForOp } from "../runtime.js";
import { createAnthropicAdapter } from "../adapters/anthropic.js";

export async function registerAdapterForChat(
  opId: string,
  prepared: PreparedAgentRequest,
  sessionId: string,
): Promise<void> {
  const forcedToolChoice = prepared.toolChoice;

  if (prepared.provider === "anthropic") {
    registerAdapterForOp(opId, () =>
      createAnthropicAdapter({
        systemPrompt: prepared.systemPrompt,
        model: prepared.model,
        sessionId,
        forcedToolChoice,
      }),
    );
    return;
  }

  if (prepared.provider === "codex") {
    const { createCodexAdapter } = await import("../adapters/codex.js");
    registerAdapterForOp(opId, () =>
      createCodexAdapter({
        systemPrompt: prepared.systemPrompt,
        model: prepared.model,
        sessionId,
        forcedToolChoice,
      }),
    );
    return;
  }

  // OpenAI-compat providers: local, ollama-cloud, xai, openai, gemini,
  // custom. One adapter, one wire shape — only the baseURL + apiKey
  // swap per provider.
  const { createOpenAICompatAdapter, resolveOpenAICompatTarget } = await import("../adapters/openai-compat.js");
  let target = await resolveOpenAICompatTarget(prepared.provider, prepared);
  if (prepared.provider === "local") {
    const { isCloudModel, getCloudOllamaCallTarget } = await import("../../ollama-cloud.js");
    if (isCloudModel(prepared.model)) {
      const cloudTarget = getCloudOllamaCallTarget();
      if (cloudTarget) target = cloudTarget;
    }
  }
  if (!target) {
    // No usable target (e.g. ollama-cloud picked but no key configured,
    // or custom provider without baseURL). Surface the failure cleanly
    // by registering a no-op adapter that errors on first runTurn.
    throw new Error(`provider ${prepared.provider} has no usable OpenAI-compat target — check API key and base URL config`);
  }
  const finalTarget = target;
  registerAdapterForOp(opId, () =>
    createOpenAICompatAdapter({
      systemPrompt: prepared.systemPrompt,
      model: prepared.model,
      baseURL: finalTarget.baseURL,
      apiKey: finalTarget.apiKey,
      temperature: prepared.temperature,
      sessionId,
      forcedToolChoice,
    }),
  );
}
