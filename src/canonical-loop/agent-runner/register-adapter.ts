import { resolveCredential } from "../../auth/resolve.js";
import { getRuntimeConfig } from "../../config.js";
import type { Op } from "../../ops/types.js";
import { registerAdapterForOp } from "../runtime.js";
import { createProviderAdapterFactory, resolveProviderRuntime } from "../provider-adapter-factory.js";
import { sealDelegatedRuntime } from "../runtime-integrity.js";
import type { CanonicalAgentOptions } from "./types.js";

export async function registerProviderAdapter(
  op: Op,
  options: CanonicalAgentOptions,
  sessionId: string,
): Promise<void> {
  const { provider, model, systemPrompt, temperature, maxTokens } = options;
  const configuredKey = provider === "openai" ? getRuntimeConfig().openaiApiKey : undefined;
  const admittedCredential = await resolveCredential(provider, {
    configOpenAIKey: configuredKey,
    requiredSource: options.authSource,
  });
  if (!admittedCredential) throw new Error(`provider ${provider} credential is unavailable at submission`);
  if (provider !== "local" && admittedCredential.credential !== options.apiKey) {
    throw new Error(`provider ${provider} credential changed before canonical submission`);
  }

  const resolvedRuntime = await resolveProviderRuntime(provider, model, {
    apiKey: options.apiKey,
    authSource: admittedCredential.source,
    customBaseURL: options.baseURL,
  });
  let credential = admittedCredential;
  if (resolvedRuntime.identity.credentialProvider !== provider) {
    const targetCredential = await resolveCredential(resolvedRuntime.identity.credentialProvider);
    if (!targetCredential || targetCredential.credential !== resolvedRuntime.apiKey) {
      throw new Error("runtime target credential changed before canonical submission");
    }
    credential = targetCredential;
  }

  // Ollama (local + cloud) reports model capabilities via /api/show. Probe once
  // before the first turn; the resolver above already selected the exact target.
  if ((provider === "local" || provider === "ollama-cloud") && resolvedRuntime.baseURL) {
    const { probeOllamaCapabilities } = await import("../../providers/ollama-capability-probe.js");
    await probeOllamaCapabilities(resolvedRuntime.baseURL, model, resolvedRuntime.apiKey || "ollama");
  }

  op.runtimeDescriptor = sealDelegatedRuntime(op.id, {
    kind: "delegated-op",
    adapter: "provider-exact",
    ...resolvedRuntime.identity,
    authSource: credential.source,
    sessionId,
  });
  op.model = model;
  const factory = await createProviderAdapterFactory(op.runtimeDescriptor, {
    apiKey: credential.credential,
    authSource: credential.source,
    customBaseURL: options.baseURL,
    systemPrompt,
    temperature,
    maxTokens,
    sessionId,
    preferAnthropicDirectHttp: options.preferAnthropicDirectHttp,
    requireToolOnFirstTurn: true,
  });
  registerAdapterForOp(op.id, factory);
}
