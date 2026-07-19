import type { TrustLevel } from "./publisher-trust.js";
import type { PluginManifestMetadata, PluginSecretRequirement } from "./manifest.js";
import type { ActivePluginToolProjection } from "./tool-surface.js";

export type PluginLifecycleStatus = "loaded" | "registered" | "disabled" | "failed" | "needs_secrets" | "ready";

export interface PluginListItem {
  id: string;
  registryId: string;
  name: string;
  version: string;
  description: string;
  publisher: string | null;
  manifestHash: string | null;
  enabled: boolean;
  status: PluginLifecycleStatus;
  trustLevel: TrustLevel | null;
  tools: string[];
  declaredTools: string[];
  activeTools: ActivePluginToolProjection[];
  requiredSecrets: PluginSecretRequirement[];
  missingSecrets: string[];
  secretsReady: boolean;
  error?: string;
}

export interface PluginProjectionSource {
  registryId: string;
  manifest?: PluginManifestMetadata;
  manifestHash?: string;
  enabled: boolean;
  status: PluginLifecycleStatus;
  trustLevel: TrustLevel | null;
  activeTools?: ActivePluginToolProjection[];
  missingSecrets?: string[];
  error?: string;
}

export function pluginListItem(source: PluginProjectionSource): PluginListItem {
  const manifest = source.manifest;
  const declaredTools = [...(manifest?.declaredTools ?? [])];
  const requiredSecrets = [...(manifest?.requiredSecrets ?? [])];
  const missingSecrets = [...(source.missingSecrets ?? [])];
  return {
    id: manifest?.id ?? source.registryId,
    registryId: source.registryId,
    name: manifest?.name ?? source.registryId,
    version: manifest?.version ?? "",
    description: manifest?.description ?? "",
    publisher: manifest?.publisher ?? null,
    manifestHash: source.manifestHash ?? null,
    enabled: source.enabled,
    status: source.status,
    trustLevel: source.trustLevel,
    tools: [...declaredTools],
    declaredTools,
    activeTools: source.status === "loaded" ? [...(source.activeTools ?? [])] : [],
    requiredSecrets,
    missingSecrets,
    secretsReady: missingSecrets.length === 0,
    ...(source.error ? { error: source.error } : {}),
  };
}

export function registeredPluginItem(id: string, enabled: boolean, error?: string): PluginListItem {
  return pluginListItem({
    registryId: id,
    enabled,
    status: error ? "failed" : !enabled ? "disabled" : "registered",
    trustLevel: null,
    ...(error ? { error } : {}),
  });
}

export function safeLifecyclePersistenceError(action: "load" | "disable"): string {
  return action === "disable"
    ? "Plugin disable could not be persisted"
    : "Plugin load could not be persisted";
}

export function safePluginId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "?").slice(0, 80);
}

export function safeRestoreError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message === "Plugin load could not be persisted") return message;
  if (message === "Plugin disable could not be persisted") return message;
  if (message.includes("manifest is not integrity-pinned")) return "Bundle manifest is not integrity-pinned";
  if (message.includes("tampered")) return "Integrity verification failed";
  if (message.startsWith("No manifest.json")) return "Manifest not found";
  if (message.startsWith("Invalid JSON") || message.startsWith("Invalid manifest")) return "Manifest is invalid";
  if (message.includes("does not match manifest ID")) return "Registry identity does not match manifest";
  if (message.startsWith("Entry point not found")) return "Entry point not found";
  if (message.startsWith("Failed to load plugin")) return "Entry point failed to load";
  if (message.includes("tool exports") || message.includes("Plugin tool")) return "Plugin tool surface is invalid";
  return "Plugin failed to restore";
}
