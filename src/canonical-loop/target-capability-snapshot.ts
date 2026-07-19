import {
  getLocalRuntimeById,
  hasPublishedCertification,
  type LocalModelCapabilityProfile,
} from "../local-runtimes/index.js";
import { runtimeTargetIdentity } from "../ops/target-identity.js";
import type {
  DelegatedRuntimeTarget,
  ExactDelegatedRuntimeDescriptor,
  PersistedTargetCapabilitySnapshot,
} from "../ops/types.js";
import { PROVIDERS, type CapabilitySupport } from "../providers/registry.js";

export function captureTargetCapabilitySnapshot(
  identity: Pick<ExactDelegatedRuntimeDescriptor, "provider" | "model" | "target">,
  localProfile: LocalModelCapabilityProfile | null,
): PersistedTargetCapabilitySnapshot {
  const effectiveProvider = identity.target.kind === "ollama-cloud"
    ? "ollama-cloud"
    : identity.provider;
  const capabilities = PROVIDERS[effectiveProvider].capabilities;
  const toolsRejected = identity.target.kind === "local-runtime"
    && localProfile?.runtimeId === identity.target.runtimeId
    && localProfile.model === identity.model
    && localProfile.tools.rejectsTools === true;
  const certified = identity.target.kind === "local-runtime"
    ? isExactLocalTargetCertified(identity.target.runtimeId, identity.model)
    : false;
  const localContext = identity.target.kind === "local-runtime"
    && localProfile?.runtimeId === identity.target.runtimeId
    && localProfile.model === identity.model
    && Number.isFinite(localProfile.contextWindow)
    && (localProfile.contextWindow ?? 0) > 0
    ? localProfile.contextWindow
    : null;

  return {
    targetIdentity: runtimeTargetIdentity(identity),
    tools: toolsRejected
      ? "unsupported"
      : certified ? "supported" : capabilityVerdict(capabilities.tools),
    toolsRejected,
    vision: capabilityVerdict(capabilities.vision),
    streaming: capabilityVerdict(capabilities.streaming),
    jsonMode: certified
      ? "supported"
      : capabilityVerdict(capabilities.structuredOutput ?? false),
    localFiles: capabilityVerdict(capabilities.localFiles),
    contextWindowTokens: localContext,
    locality: targetLocality(identity.target),
  };
}

export function assertPersistedTargetCapabilitySnapshot(
  value: unknown,
  identity: Pick<ExactDelegatedRuntimeDescriptor, "provider" | "model" | "target">,
): void {
  const snapshot = value as Partial<PersistedTargetCapabilitySnapshot> | null;
  const verdicts = [
    snapshot?.tools,
    snapshot?.vision,
    snapshot?.streaming,
    snapshot?.jsonMode,
    snapshot?.localFiles,
  ];
  if (!snapshot || snapshot.targetIdentity !== runtimeTargetIdentity(identity)) {
    throw new Error("invalid delegated capability target identity");
  }
  if (verdicts.some(verdict => !["supported", "unsupported", "unknown"].includes(verdict as string))) {
    throw new Error("invalid delegated capability verdict");
  }
  if (typeof snapshot.toolsRejected !== "boolean") throw new Error("invalid delegated tool rejection fact");
  const contextWindowTokens = snapshot.contextWindowTokens;
  if (contextWindowTokens !== null
    && (typeof contextWindowTokens !== "number"
      || !Number.isFinite(contextWindowTokens)
      || contextWindowTokens <= 0)) {
    throw new Error("invalid delegated context-window fact");
  }
  if (!["local", "remote", "unknown"].includes(snapshot.locality as string)) {
    throw new Error("invalid delegated locality fact");
  }
}

function isExactLocalTargetCertified(runtimeId: string, modelId: string): boolean {
  const runtime = getLocalRuntimeById(runtimeId);
  const model = runtime?.models.find(candidate => candidate.id === modelId);
  return !!runtime && !!model && hasPublishedCertification(runtime, model);
}

function capabilityVerdict(value: CapabilitySupport): PersistedTargetCapabilitySnapshot["tools"] {
  if (value === "target-dependent") return "unknown";
  return value ? "supported" : "unsupported";
}

function targetLocality(target: DelegatedRuntimeTarget): PersistedTargetCapabilitySnapshot["locality"] {
  if (target.kind === "local-runtime" || target.kind === "local-config") return "local";
  if (target.kind === "custom-config") return target.locality ?? "unknown";
  return "remote";
}
