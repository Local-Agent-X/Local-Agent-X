import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { CredentialSource } from "../auth/auth-provider.js";
import type {
  DelegatedProviderRuntime,
  DelegatedRuntimeTarget,
  ExactDelegatedRuntimeDescriptor,
} from "../ops/types.js";
import { PROVIDER_IDS, type ProviderId } from "../providers/provider-ids.js";
import type { LocalModelCapabilityProfile } from "../local-runtimes/index.js";
import type { AdapterFactory } from "./runtime.js";
import { API_BASE as ANTHROPIC_API_BASE } from "../anthropic-client/request.js";
import { CODEX_URL } from "../codex-client/types.js";
import { GEMINI_BASE } from "./adapters/gemini-native-transport.js";
import {
  assertPersistedTargetCapabilitySnapshot,
  captureTargetCapabilitySnapshot,
} from "./target-capability-snapshot.js";
export { captureTargetCapabilitySnapshot } from "./target-capability-snapshot.js";

interface ProviderRuntimeOptions {
  apiKey: string;
  authSource: CredentialSource;
  customBaseURL?: string;
}

interface ProviderAdapterOptions extends ProviderRuntimeOptions {
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  sessionId?: string;
  preferAnthropicDirectHttp?: boolean;
  requireToolOnFirstTurn?: boolean;
}

export class RuntimeIdentityMismatchError extends Error {
  constructor(public readonly code: string, message = `delegated runtime identity mismatch: ${code}`) {
    super(message);
    this.name = "RuntimeIdentityMismatchError";
  }
}

function identityMismatch(code: string): never {
  throw new RuntimeIdentityMismatchError(code);
}

type RuntimeIdentity = Omit<ExactDelegatedRuntimeDescriptor, "kind" | "adapter" | "sessionId" | "surface" | "integrity">;

export interface ResolvedProviderRuntime {
  identity: RuntimeIdentity;
  apiKey: string;
  baseURL?: string;
  localModelCapabilityProfile: LocalModelCapabilityProfile | null;
}

export async function resolveProviderRuntime(
  provider: ProviderId,
  model: string,
  options: ProviderRuntimeOptions,
): Promise<ResolvedProviderRuntime> {
  if (!model.trim()) throw new Error(`provider ${provider} resolved an empty model`);
  if (provider === "anthropic") return directIdentity(provider, model, "anthropic", options);
  if (provider === "codex") return directIdentity(provider, model, "codex", options);
  if (provider === "gemini") return directIdentity(provider, model, "gemini-native", options);

  const target = await resolveOpenAITarget(provider, model, options);
  if (!target) throw new Error(`provider ${provider} has no usable OpenAI-compat target`);
  const credentialProvider = provider === "local" && target.cloud ? "ollama-cloud" : provider;
  const runtimeIdentity = {
    provider,
    credentialProvider,
    authSource: options.authSource,
    model,
    runtime: "openai-compat" as const,
    target: target.identity,
  };
  return {
    identity: {
      ...runtimeIdentity,
      capabilitySnapshot: captureTargetCapabilitySnapshot(runtimeIdentity, target.modelProfile ?? null),
    },
    apiKey: target.apiKey,
    baseURL: target.baseURL,
    localModelCapabilityProfile: provider === "local" ? target.modelProfile ?? null : null,
  };
}

function directIdentity(
  provider: ProviderId,
  model: string,
  runtime: DelegatedProviderRuntime,
  options: ProviderRuntimeOptions,
): ResolvedProviderRuntime {
  const target: DelegatedRuntimeTarget = {
    kind: "provider-registry",
    endpointFingerprint: endpointFingerprint(providerRegistryEndpoint(provider)),
  };
  const runtimeIdentity = {
    provider,
    credentialProvider: provider,
    authSource: options.authSource,
    model,
    runtime,
    target,
  };
  return {
    identity: {
      ...runtimeIdentity,
      capabilitySnapshot: captureTargetCapabilitySnapshot(runtimeIdentity, null),
    },
    apiKey: options.apiKey,
    localModelCapabilityProfile: null,
  };
}

export async function createProviderAdapterFactory(
  identity: Omit<ExactDelegatedRuntimeDescriptor, "kind" | "adapter">,
  options: ProviderAdapterOptions,
): Promise<AdapterFactory> {
  assertRuntimeMatchesProvider(identity.provider, identity.runtime, identity.target);
  if (identity.target.kind === "provider-registry" && identity.runtime !== "openai-compat") {
    assertFingerprint(providerRegistryEndpoint(identity.provider), identity.target.endpointFingerprint);
  }
  if (identity.authSource !== options.authSource) identityMismatch("auth_source_changed");
  if (identity.runtime === "anthropic") {
    if (!options.apiKey) throw new Error("persisted Anthropic credential is unavailable");
    const [{ createAnthropicAdapter }, { defaultAnthropicTransport }] = await Promise.all([
      import("./adapters/anthropic.js"),
      import("./adapters/anthropic-transport.js"),
    ]);
    const transport = defaultAnthropicTransport({ credential: options.apiKey, source: identity.authSource });
    return () => createAnthropicAdapter({
      model: identity.model,
      systemPrompt: options.systemPrompt,
      sessionId: options.sessionId ?? identity.sessionId,
      maxTokens: options.maxTokens,
      preferDirectHttp: options.preferAnthropicDirectHttp,
      transport,
    });
  }
  if (identity.runtime === "codex") {
    if (!options.apiKey) throw new Error("persisted Codex credential is unavailable");
    const [{ createCodexAdapter }, { defaultCodexTransport }] = await Promise.all([
      import("./adapters/codex.js"),
      import("./adapters/codex-transport.js"),
    ]);
    const transport = defaultCodexTransport({ credential: options.apiKey, source: identity.authSource });
    return () => createCodexAdapter({
      model: identity.model,
      systemPrompt: options.systemPrompt,
      sessionId: options.sessionId ?? identity.sessionId,
      transport,
    });
  }
  if (identity.runtime === "gemini-native") {
    if (!options.apiKey) throw new Error("persisted Gemini provider credential is unavailable");
    const { createGeminiNativeAdapter } = await import("./adapters/gemini-native.js");
    return () => createGeminiNativeAdapter({
      model: identity.model,
      apiKey: options.apiKey,
      systemPrompt: options.systemPrompt,
      temperature: options.temperature,
      thinking: /gemini-(2\.5|3)/i.test(identity.model),
      sessionId: options.sessionId ?? identity.sessionId,
    });
  }

  const baseURL = await resolvePersistedTarget(identity, options);
  if (!options.apiKey && identity.credentialProvider !== "local") {
    throw new Error(`persisted provider ${identity.provider} credential is unavailable`);
  }
  const { createOpenAICompatAdapter } = await import("./adapters/openai-compat.js");
  return () => createOpenAICompatAdapter({
    model: identity.model,
    baseURL,
    apiKey: options.apiKey || "ollama",
    systemPrompt: options.systemPrompt,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    sessionId: options.sessionId ?? identity.sessionId,
    requireToolOnFirstTurn: options.requireToolOnFirstTurn,
  });
}

export function assertExactDelegatedRuntime(value: unknown): asserts value is ExactDelegatedRuntimeDescriptor {
  const d = value as Partial<ExactDelegatedRuntimeDescriptor> & { baseURL?: unknown } | null;
  if (!d || d.kind !== "delegated-op" || d.adapter !== "provider-exact") throw new Error("legacy or missing delegated runtime identity");
  if ("baseURL" in d) throw new Error("persisted delegated runtime must not carry an executable URL");
  if (!isProviderId(d.provider) || !isProviderId(d.credentialProvider) || typeof d.model !== "string" || !d.model.trim()) throw new Error("invalid delegated provider/model identity");
  if (!isCredentialSource(d.authSource) || !isRuntime(d.runtime)) throw new Error("invalid delegated credential/runtime identity");
  if (d.sessionId !== undefined && typeof d.sessionId !== "string") throw new Error("invalid delegated session identity");
  if (d.integrity?.scheme !== "hmac-sha256-v1" || !isFingerprint(d.integrity.mac)) throw new Error("invalid delegated runtime integrity metadata");
  if (d.surface !== undefined) assertSurface(d.surface);
  if (!isTarget(d.target)) throw new Error("invalid delegated runtime target");
  assertRuntimeMatchesProvider(d.provider, d.runtime, d.target);
  if (d.capabilitySnapshot !== undefined) {
    assertPersistedTargetCapabilitySnapshot(d.capabilitySnapshot, {
      provider: d.provider,
      model: d.model,
      target: d.target,
    });
  }
  const credentialMatches = d.credentialProvider === d.provider
    || (d.provider === "local" && d.credentialProvider === "ollama-cloud");
  if (!credentialMatches) throw new Error("persisted credential provider does not match provider runtime");
  if (d.credentialProvider === "local" && d.authSource !== "sentinel") throw new Error("local runtime must use sentinel authentication");
}

async function resolvePersistedTarget(
  identity: Omit<ExactDelegatedRuntimeDescriptor, "kind" | "adapter">,
  options: ProviderRuntimeOptions,
): Promise<string> {
  if (identity.target.kind === "ollama-cloud") {
    const { getRuntimeConfig } = await import("../config.js");
    const configured = `${getRuntimeConfig().ollamaCloudUrl.replace(/\/+$/, "")}/v1`;
    assertFingerprint(configured, identity.target.endpointFingerprint);
    return configured;
  }
  if (identity.target.kind === "local-runtime") {
    const local = await import("../local-runtimes/index.js");
    let runtime = local.getLocalRuntimeById(identity.target.runtimeId);
    if (!runtime) {
      await local.refreshLocalRuntimes();
      runtime = local.getLocalRuntimeById(identity.target.runtimeId);
    }
    if (!runtime || !runtime.models.some(candidate => candidate.id === identity.model)) {
      throw new Error("persisted local runtime/model is no longer admitted");
    }
    assertFingerprint(runtime.chatBaseUrl, identity.target.endpointFingerprint);
    return rewriteVerifiedLocalEndpointForContainer(runtime.chatBaseUrl);
  }
  const target = await resolveOpenAITarget(identity.provider, identity.model, options);
  if (!target || !sameTargetKind(identity.target, target.identity)) {
    identityMismatch("target_kind_changed");
  }
  if ("endpointFingerprint" in identity.target) assertFingerprint(target.baseURL, identity.target.endpointFingerprint);
  return identity.provider === "local"
    ? rewriteVerifiedLocalEndpointForContainer(target.baseURL)
    : target.baseURL;
}

export function rewriteVerifiedLocalEndpointForContainer(raw: string): string {
  const gateway = process.env.LAX_CONTAINER_HOST_GATEWAY?.trim();
  if (!gateway) return raw;
  if (!/^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[A-Fa-f0-9:]+\])$/.test(gateway)) {
    throw new RuntimeIdentityMismatchError("container_gateway_invalid");
  }
  const url = new URL(raw);
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname.toLowerCase())) {
    throw new RuntimeIdentityMismatchError("container_gateway_non_loopback");
  }
  url.hostname = gateway;
  return url.href.replace(/\/$/, raw.endsWith("/") ? "/" : "");
}

async function resolveOpenAITarget(
  provider: ProviderId,
  model: string,
  options: Pick<ProviderRuntimeOptions, "apiKey" | "customBaseURL">,
): Promise<{ baseURL: string; apiKey: string; modelProfile?: LocalModelCapabilityProfile; identity: DelegatedRuntimeTarget; cloud: boolean } | null> {
  const { resolveOpenAICompatTarget } = await import("./adapters/openai-compat.js");
  const target = await resolveOpenAICompatTarget(provider, options, model);
  if (!target) return null;
  const fingerprint = endpointFingerprint(target.baseURL);
  if (provider === "custom") {
    const { isLoopbackOrPrivateUrl } = await import("../local-only-policy.js");
    return {
      ...target,
      identity: {
        kind: "custom-config",
        endpointFingerprint: fingerprint,
        locality: isLoopbackOrPrivateUrl(target.baseURL) ? "local" : "remote",
      },
      cloud: false,
    };
  }
  if (provider === "ollama-cloud") return { ...target, identity: { kind: "ollama-cloud", endpointFingerprint: fingerprint }, cloud: true };
  if (provider === "local") {
    const { isCloudModel } = await import("../ollama-cloud.js");
    if (isCloudModel(model)) return { ...target, identity: { kind: "ollama-cloud", endpointFingerprint: fingerprint }, cloud: true };
    const runtimeId = target.modelProfile?.runtimeId;
    const identity: DelegatedRuntimeTarget = runtimeId
      ? { kind: "local-runtime", runtimeId, endpointFingerprint: fingerprint }
      : { kind: "local-config", endpointFingerprint: fingerprint };
    return { ...target, identity, cloud: false };
  }
  return {
    ...target,
    identity: { kind: "provider-registry", endpointFingerprint: fingerprint },
    cloud: false,
  };
}

function assertRuntimeMatchesProvider(provider: ProviderId, runtime: DelegatedProviderRuntime, target: unknown): void {
  const expected: DelegatedProviderRuntime = provider === "anthropic" ? "anthropic"
    : provider === "codex" ? "codex"
      : provider === "gemini" ? "gemini-native" : "openai-compat";
  if (runtime !== expected) identityMismatch("provider_runtime_changed");
  if (!isTarget(target)) identityMismatch("target_invalid");
  if (runtime !== "openai-compat" && target.kind !== "provider-registry") identityMismatch("direct_target_changed");
  if (provider === "custom" && target.kind !== "custom-config") identityMismatch("custom_target_changed");
  if (provider === "ollama-cloud" && target.kind !== "ollama-cloud") identityMismatch("ollama_cloud_target_changed");
  if (provider === "local" && !["local-runtime", "local-config", "ollama-cloud"].includes(target.kind)) identityMismatch("local_target_changed");
}

function endpointFingerprint(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { identityMismatch("endpoint_invalid"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") identityMismatch("endpoint_protocol_changed");
  if (url.username || url.password || url.search || url.hash) identityMismatch("endpoint_shape_changed");
  return createHash("sha256").update(url.href).digest("hex");
}

function assertFingerprint(raw: string, expected: string): void {
  if (endpointFingerprint(raw) !== expected) {
    throw new RuntimeIdentityMismatchError(
      "endpoint_fingerprint_changed",
      "canonical provider endpoint changed since submission",
    );
  }
}

function sameTargetKind(a: DelegatedRuntimeTarget, b: DelegatedRuntimeTarget): boolean {
  return a.kind === b.kind && (a.kind !== "local-runtime" || (b.kind === "local-runtime" && a.runtimeId === b.runtimeId));
}

function isTarget(value: unknown): value is DelegatedRuntimeTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Partial<DelegatedRuntimeTarget>;
  if (target.kind === "provider-registry") return isFingerprint(target.endpointFingerprint);
  if (target.kind === "local-runtime") return typeof target.runtimeId === "string" && !!target.runtimeId && isFingerprint(target.endpointFingerprint);
  if (target.kind === "custom-config") {
    return isFingerprint(target.endpointFingerprint)
      && (target.locality === undefined || target.locality === "local" || target.locality === "remote");
  }
  return (target.kind === "ollama-cloud" || target.kind === "local-config") && isFingerprint(target.endpointFingerprint);
}

function assertSurface(value: unknown): void {
  const surface = value as Partial<NonNullable<ExactDelegatedRuntimeDescriptor["surface"]>> | null;
  if (!surface || surface.kind !== "agent-runner" || typeof surface.systemPrompt !== "string") throw new Error("invalid delegated agent surface");
  if (!Array.isArray(surface.tools) || surface.tools.some(tool => !tool || typeof tool.name !== "string" || !tool.name || !isFingerprint(tool.fingerprint))) throw new Error("invalid delegated tool surface");
  if (!surface.security || typeof surface.security.workspace !== "string" || !surface.security.workspace || !isFingerprint(surface.security.configFingerprint)) throw new Error("invalid delegated security surface");
  if (!["workspace", "common", "unrestricted"].includes(surface.security.fileAccessMode)) throw new Error("invalid delegated file-access surface");
  if (!["refuse", "allow"].includes(surface.security.inlineEvalPolicy)) throw new Error("invalid delegated inline-eval surface");
  if (!Array.isArray(surface.security.allowedPaths)
    || surface.security.allowedPaths.some(entry => !entry || typeof entry.sessionId !== "string"
      || typeof entry.path !== "string" || !isAbsolute(entry.path))) throw new Error("invalid delegated allowed-path surface");
  if (surface.security.sessionWorkRoot !== undefined && !isAbsolute(surface.security.sessionWorkRoot)) throw new Error("invalid delegated work-root surface");
  if (surface.toolPolicyFingerprint !== undefined && !isFingerprint(surface.toolPolicyFingerprint)) throw new Error("invalid delegated tool-policy surface");
  if (surface.threatEngine !== false && (!surface.threatEngine || typeof surface.threatEngine !== "object" || !("state" in surface.threatEngine))) throw new Error("invalid delegated threat-engine surface");
  if (typeof surface.rbac !== "boolean") throw new Error("invalid delegated security service surface");
  if (!["local", "api", "bridge", "cron", "delegated"].includes(surface.callContext as string)) throw new Error("invalid delegated call context");
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

function isCredentialSource(value: unknown): value is CredentialSource {
  return value === "oauth" || value === "env" || value === "secrets-store" || value === "config" || value === "sentinel";
}

function isRuntime(value: unknown): value is DelegatedProviderRuntime {
  return value === "anthropic" || value === "codex" || value === "gemini-native" || value === "openai-compat";
}

function providerRegistryEndpoint(provider: ProviderId): string {
  if (provider === "anthropic") return ANTHROPIC_API_BASE;
  if (provider === "codex") return CODEX_URL;
  if (provider === "gemini") return GEMINI_BASE;
  throw new Error(`provider ${provider} has no direct endpoint identity`);
}
