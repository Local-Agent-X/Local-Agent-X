import type { CredentialResolution } from "../../auth/resolve.js";
import { resolveCredential } from "../../auth/resolve.js";
import { getRuntimeConfig } from "../../config.js";
import type { Op } from "../../ops/types.js";
import { registerAdapterForOp } from "../runtime.js";
import {
  createProviderAdapterFactory,
  captureTargetCapabilitySnapshot,
  resolveProviderRuntime,
  type ResolvedProviderRuntime,
} from "../provider-adapter-factory.js";
import { sealDelegatedRuntime } from "../runtime-integrity.js";
import type { CanonicalAgentOptions } from "./types.js";

export interface PreparedAgentProviderRuntime {
  resolvedRuntime: ResolvedProviderRuntime;
  credential: CredentialResolution;
}

export async function resolveAgentProviderRuntime(
  options: CanonicalAgentOptions,
): Promise<PreparedAgentProviderRuntime> {
  const { provider, model } = options;
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
  return { resolvedRuntime, credential };
}

export async function registerProviderAdapter(
  op: Op,
  options: CanonicalAgentOptions,
  sessionId: string,
  prepared?: PreparedAgentProviderRuntime,
): Promise<void> {
  const { provider, model, systemPrompt, temperature, maxTokens } = options;
  const { resolvedRuntime, credential } = prepared ?? await resolveAgentProviderRuntime(options);

  if ((provider === "local" || provider === "ollama-cloud") && resolvedRuntime.baseURL) {
    const { probeOllamaCapabilities } = await import("../../providers/ollama-capability-probe.js");
    await probeOllamaCapabilities(resolvedRuntime.baseURL, model, resolvedRuntime.apiKey || "ollama");
    if (resolvedRuntime.identity.target.kind === "local-runtime") {
      const { getLocalModelCapabilityProfile } = await import("../../local-runtimes/index.js");
      resolvedRuntime.localModelCapabilityProfile = getLocalModelCapabilityProfile(
        resolvedRuntime.baseURL,
        model,
      );
      resolvedRuntime.identity.capabilitySnapshot = captureTargetCapabilitySnapshot(
        resolvedRuntime.identity,
        resolvedRuntime.localModelCapabilityProfile,
      );
    }
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
