import type { OpMessageRow } from "../canonical-loop/index.js";
import { estimateTokens } from "../context-manager/token-estimation.js";
import { OUTPUT_RESERVE_TOKENS } from "../context-manager/request-fit.js";
import { PROVIDER_IDS, type ProviderId } from "../providers/provider-ids.js";
import { runtimeTargetIdentity } from "./target-identity.js";
import type {
  CapabilityVerdict,
  DelegatedRuntimeTarget,
  Op,
  PersistedTargetCapabilitySnapshot,
  ProviderCapabilityRequirement,
  TargetPin,
} from "./types.js";

export type TargetCapabilitySnapshot = Omit<
  PersistedTargetCapabilitySnapshot,
  "targetIdentity"
>;

export interface EffectiveOperationRequirements {
  requirements: ProviderCapabilityRequirement;
  currentTarget: {
    provider: ProviderId;
    model: string;
    target: DelegatedRuntimeTarget;
    capabilities: TargetCapabilitySnapshot;
  } | null;
  pinnedTarget: TargetPin | null;
  evidence: {
    actualToolUse: boolean;
    imageInput: boolean;
    persistedToolSurface: boolean;
    measuredContextFloor: boolean;
  };
}

type RequirementMessage = Pick<OpMessageRow, "role" | "content">;

interface NormalizedDescriptor {
  provider: ProviderId;
  model: string;
  target: DelegatedRuntimeTarget;
  surfaceToolCount: number | null;
  capabilities: TargetCapabilitySnapshot;
}

/** Pure persisted-fact resolver. It never consults runtime or settings state. */
export function resolveOperationRequirements(
  op: Op,
  messages: readonly RequirementMessage[],
): EffectiveOperationRequirements {
  const root = record(op);
  const pack = record(root?.contextPack);
  const context = record(pack?.context);
  const routing = record(pack?.routing);
  const descriptor = normalizeDescriptor(root?.runtimeDescriptor);
  const canonicalMessages = array(messages);
  const recentTurns = array(context?.recentTurns);
  const explicit = normalizeExplicitRequirements(pack?.capabilities);
  const persistedToolSurface = (descriptor?.surfaceToolCount ?? 0) > 0;
  const actualToolUse = canonicalMessages.some(hasCanonicalToolUse)
    || recentTurns.some(hasChatToolUse);
  const imageInput = canonicalMessages.some(hasCanonicalImage)
    || recentTurns.some(hasChatImage);
  const measuredContextFloor = resolveMeasuredContextFloor(
    pack?.promptTelemetry,
    descriptor?.surfaceToolCount ?? null,
    canonicalMessages.length > 0 ? canonicalMessages : recentTurns,
  );
  const minimumContextTokens = Math.max(
    explicit.minimumContextTokens ?? 0,
    explicit.needsLongContext ? 100_001 : 0,
    measuredContextFloor ?? 0,
  );
  const locality = descriptor?.capabilities.locality ?? "unknown";

  const requirements: ProviderCapabilityRequirement = {
    ...(explicit.needsTools || persistedToolSurface || actualToolUse ? { needsTools: true } : {}),
    ...(explicit.needsVision || imageInput ? { needsVision: true } : {}),
    ...(explicit.needsLongContext ? { needsLongContext: true } : {}),
    ...(explicit.needsStreaming ? { needsStreaming: true } : {}),
    ...(explicit.needsJsonMode ? { needsJsonMode: true } : {}),
    ...(explicit.needsLocalFiles ? { needsLocalFiles: true } : {}),
    ...(minimumContextTokens > 0 ? { minimumContextTokens } : {}),
    ...(explicit.locality === "local-only" || locality === "local"
      ? { locality: "local-only" as const }
      : {}),
  };

  return {
    requirements,
    currentTarget: descriptor ? {
      provider: descriptor.provider,
      model: descriptor.model,
      target: descriptor.target,
      capabilities: descriptor.capabilities,
    } : null,
    pinnedTarget: normalizeTargetPin(routing?.targetPin),
    evidence: {
      actualToolUse,
      imageInput,
      persistedToolSurface,
      measuredContextFloor: measuredContextFloor !== null,
    },
  };
}

function normalizeDescriptor(value: unknown): NormalizedDescriptor | null {
  const descriptor = record(value);
  if (descriptor?.kind !== "delegated-op" || descriptor.adapter !== "provider-exact") return null;
  if (!isProviderId(descriptor.provider)) return null;
  const model = nonEmptyString(descriptor.model);
  const target = normalizeTarget(descriptor.target);
  if (!model || !target) return null;
  const surface = record(descriptor.surface);
  const tools = surface && Array.isArray(surface.tools) ? surface.tools : null;
  const surfaceToolCount = tools && tools.every(isPersistedTool) ? tools.length : null;
  return {
    provider: descriptor.provider,
    model,
    target,
    surfaceToolCount,
    capabilities: normalizeCapabilitySnapshot(descriptor.capabilitySnapshot, {
      provider: descriptor.provider,
      model,
      target,
    }),
  };
}

function normalizeCapabilitySnapshot(
  value: unknown,
  identity: { provider: ProviderId; model: string; target: DelegatedRuntimeTarget },
): TargetCapabilitySnapshot {
  const snapshot = record(value);
  const locality = targetLocality(identity.target);
  if (!isCompleteCapabilitySnapshot(snapshot, runtimeTargetIdentity(identity))) {
    return unknownCapabilitySnapshot(locality);
  }
  const toolsRejected = snapshot.toolsRejected;
  return {
    tools: toolsRejected
      ? "unsupported"
      : snapshot.tools,
    toolsRejected,
    vision: snapshot.vision,
    streaming: snapshot.streaming,
    jsonMode: snapshot.jsonMode,
    localFiles: snapshot.localFiles,
    contextWindowTokens: snapshot.contextWindowTokens,
    locality,
  };
}

function isCompleteCapabilitySnapshot(
  snapshot: Record<string, unknown> | null,
  targetIdentity: string,
): snapshot is Record<string, unknown> & PersistedTargetCapabilitySnapshot {
  return snapshot?.targetIdentity === targetIdentity
    && typeof snapshot.toolsRejected === "boolean"
    && isCapabilityVerdict(snapshot.tools)
    && isCapabilityVerdict(snapshot.vision)
    && isCapabilityVerdict(snapshot.streaming)
    && isCapabilityVerdict(snapshot.jsonMode)
    && isCapabilityVerdict(snapshot.localFiles)
    && (snapshot.contextWindowTokens === null || positiveNumber(snapshot.contextWindowTokens) !== null)
    && (snapshot.locality === "local" || snapshot.locality === "remote" || snapshot.locality === "unknown");
}

function unknownCapabilitySnapshot(
  locality: TargetCapabilitySnapshot["locality"],
): TargetCapabilitySnapshot {
  return {
    tools: "unknown",
    toolsRejected: false,
    vision: "unknown",
    streaming: "unknown",
    jsonMode: "unknown",
    localFiles: "unknown",
    contextWindowTokens: null,
    locality,
  };
}

function resolveMeasuredContextFloor(
  value: unknown,
  surfaceToolCount: number | null,
  messages: readonly unknown[],
): number | null {
  const telemetry = record(value);
  const promptTokens = nonNegativeNumber(telemetry?.estimatedTokens);
  const toolTokens = nonNegativeNumber(telemetry?.toolSchemaEstimatedTokens);
  const loadedToolCount = nonNegativeInteger(telemetry?.loadedToolCount);
  if (promptTokens === null || toolTokens === null || loadedToolCount === null) return null;
  if (loadedToolCount > 0 && surfaceToolCount !== loadedToolCount) return null;
  let messageTokens = 0;
  for (const message of messages) {
    const serialized = safeStringify(record(message)?.content ?? "");
    if (serialized === null) return null;
    messageTokens += 4 + estimateTokens(serialized);
  }
  return promptTokens + toolTokens + messageTokens + OUTPUT_RESERVE_TOKENS;
}

function normalizeExplicitRequirements(value: unknown): ProviderCapabilityRequirement {
  const input = record(value);
  return {
    ...(input?.needsTools === true ? { needsTools: true } : {}),
    ...(input?.needsVision === true ? { needsVision: true } : {}),
    ...(input?.needsLongContext === true ? { needsLongContext: true } : {}),
    ...(input?.needsStreaming === true ? { needsStreaming: true } : {}),
    ...(input?.needsJsonMode === true ? { needsJsonMode: true } : {}),
    ...(input?.needsLocalFiles === true ? { needsLocalFiles: true } : {}),
    ...(positiveNumber(input?.minimumContextTokens) !== null
      ? { minimumContextTokens: positiveNumber(input?.minimumContextTokens)! }
      : {}),
    ...(input?.locality === "local-only" ? { locality: "local-only" as const } : {}),
  };
}

function normalizeTargetPin(value: unknown): TargetPin | null {
  const pin = record(value);
  if (!pin) return null;
  const provider = isProviderId(pin.provider) ? pin.provider : undefined;
  const model = nonEmptyString(pin.model) ?? undefined;
  return provider || model ? { ...(provider ? { provider } : {}), ...(model ? { model } : {}) } : null;
}

function normalizeTarget(value: unknown): DelegatedRuntimeTarget | null {
  const target = record(value);
  const endpointFingerprint = fingerprint(target?.endpointFingerprint);
  if (!target || !endpointFingerprint) return null;
  if (target.kind === "provider-registry" || target.kind === "ollama-cloud" || target.kind === "local-config") {
    return { kind: target.kind, endpointFingerprint };
  }
  if (target.kind === "local-runtime") {
    const runtimeId = nonEmptyString(target.runtimeId);
    return runtimeId ? { kind: "local-runtime", runtimeId, endpointFingerprint } : null;
  }
  if (target.kind === "custom-config") {
    const locality = target.locality === "local" || target.locality === "remote"
      ? target.locality
      : undefined;
    return { kind: "custom-config", endpointFingerprint, ...(locality ? { locality } : {}) };
  }
  return null;
}

function targetLocality(target: DelegatedRuntimeTarget): TargetCapabilitySnapshot["locality"] {
  if (target.kind === "local-runtime" || target.kind === "local-config") return "local";
  if (target.kind === "custom-config") return target.locality ?? "unknown";
  return "remote";
}

function hasCanonicalToolUse(value: unknown): boolean {
  const message = record(value);
  if (message?.role === "tool_result") return true;
  const content = record(message?.content);
  return Array.isArray(content?.toolCalls) && content.toolCalls.length > 0;
}

function hasCanonicalImage(value: unknown): boolean {
  const content = record(record(value)?.content);
  return Array.isArray(content?.images) && content.images.length > 0;
}

function hasChatToolUse(value: unknown): boolean {
  const message = record(value);
  return message?.role === "tool"
    || (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0);
}

function hasChatImage(value: unknown): boolean {
  const message = record(value);
  if (Array.isArray(message?.images) && message.images.length > 0) return true;
  return Array.isArray(message?.content)
    && message.content.some(part => record(part)?.type === "image_url");
}

function isPersistedTool(value: unknown): boolean {
  const tool = record(value);
  return !!nonEmptyString(tool?.name) && !!fingerprint(tool?.fingerprint);
}

function isCapabilityVerdict(value: unknown): value is CapabilityVerdict {
  return value === "supported" || value === "unsupported" || value === "unknown";
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

function fingerprint(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function safeStringify(value: unknown): string | null {
  try { return JSON.stringify(value) ?? ""; } catch { return null; }
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
