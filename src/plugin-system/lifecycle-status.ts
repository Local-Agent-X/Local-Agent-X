import type { TrustLevel } from "./publisher-trust.js";
import type { PluginManifest } from "./manifest.js";

export type PluginLifecycleStatus = "loaded" | "registered" | "disabled" | "failed";

export interface PluginListItem extends PluginManifest {
  enabled: boolean;
  status: PluginLifecycleStatus;
  trustLevel: TrustLevel | null;
  error?: string;
}

export function registeredPluginItem(id: string, enabled: boolean, error?: string): PluginListItem {
  return {
    id,
    name: id,
    version: "",
    description: "",
    entryPoint: "",
    tools: [],
    enabled,
    status: error ? "failed" : !enabled ? "disabled" : "registered",
    trustLevel: null,
    ...(error ? { error } : {}),
  };
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
  return "Plugin failed to restore";
}
