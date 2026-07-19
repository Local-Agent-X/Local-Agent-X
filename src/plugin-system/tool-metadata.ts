import type { KernelClass, ToolRisk } from "../tool-registry.js";

export interface ActivePluginToolMetadata {
  ownerId: string;
  activationToken: symbol;
  kernel: KernelClass;
  risk: ToolRisk;
}

const activeTools = new Map<string, ActivePluginToolMetadata>();

export function activatePluginToolMetadata(name: string, metadata: ActivePluginToolMetadata): void {
  const current = activeTools.get(name);
  if (current && (current.ownerId !== metadata.ownerId || current.activationToken !== metadata.activationToken)) {
    throw new Error(`Plugin tool "${name}" is already active`);
  }
  activeTools.set(name, metadata);
}

export function deactivatePluginToolMetadata(
  name: string,
  ownerId: string,
  activationToken: symbol,
): void {
  const current = activeTools.get(name);
  if (current?.ownerId === ownerId && current.activationToken === activationToken) activeTools.delete(name);
}

export function getActivePluginToolMetadata(name: string): ActivePluginToolMetadata | undefined {
  return activeTools.get(name);
}

