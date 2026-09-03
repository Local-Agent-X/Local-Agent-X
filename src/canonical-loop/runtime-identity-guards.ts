// Shape validators for a persisted delegated-runtime identity.
//
// Split out of provider-adapter-factory.ts, which owns the *decisions*
// (resolve a runtime, build an adapter, prove the endpoint hasn't moved) and
// was at the 400-LOC ceiling. These are the pure predicates those decisions
// lean on: no I/O, no local state, and nothing here throws a
// RuntimeIdentityMismatchError — callers decide what a `false` means. That
// dependency direction is what keeps the split acyclic: the guards never
// import the factory back.
import { isAbsolute } from "node:path";
import type { CredentialSource } from "../auth/auth-provider.js";
import type {
  DelegatedProviderRuntime,
  DelegatedRuntimeTarget,
  ExactDelegatedRuntimeDescriptor,
} from "../ops/types.js";
import { PROVIDER_IDS, type ProviderId } from "../providers/provider-ids.js";

export function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

export function isCredentialSource(value: unknown): value is CredentialSource {
  return value === "oauth" || value === "env" || value === "secrets-store" || value === "config" || value === "sentinel";
}

export function isRuntime(value: unknown): value is DelegatedProviderRuntime {
  return value === "anthropic" || value === "codex" || value === "gemini-native" || value === "openai-compat";
}

export function sameTargetKind(a: DelegatedRuntimeTarget, b: DelegatedRuntimeTarget): boolean {
  return a.kind === b.kind && (a.kind !== "local-runtime" || (b.kind === "local-runtime" && a.runtimeId === b.runtimeId));
}

export function isTarget(value: unknown): value is DelegatedRuntimeTarget {
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

export function assertSurface(value: unknown): void {
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
