import type { PluginManifest, TrustLevel } from "../plugin-system.js";

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
    status: !enabled ? "disabled" : error ? "failed" : "registered",
    trustLevel: null,
    ...(error ? { error } : {}),
  };
}

export function safePluginId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "?").slice(0, 80);
}

export function safeRestoreError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("tampered")) return "Integrity verification failed";
  if (message.startsWith("No manifest.json")) return "Manifest not found";
  if (message.startsWith("Invalid JSON") || message.startsWith("Invalid manifest")) return "Manifest is invalid";
  if (message.includes("does not match manifest ID")) return "Registry identity does not match manifest";
  if (message.startsWith("Entry point not found")) return "Entry point not found";
  if (message.startsWith("Failed to load plugin")) return "Entry point failed to load";
  return "Plugin failed to restore";
}
