import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFileSync, ensureDirFor } from "../util/json-store.js";

export interface PluginRegistryEntry {
  enabled: boolean;
  path: string;
  entryHash?: string;
  manifestHash?: string;
}

export interface PluginRegistry {
  [pluginId: string]: PluginRegistryEntry;
}

export interface PluginRegistryStore {
  read(): PluginRegistry;
  write(registry: PluginRegistry): void;
}

function parseRegistry(raw: string): PluginRegistry {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Plugin registry is invalid");
  }
  const registry = parsed as Record<string, unknown>;
  for (const entry of Object.values(registry)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Plugin registry is invalid");
    }
    const value = entry as Record<string, unknown>;
    if (typeof value.enabled !== "boolean" || typeof value.path !== "string" || !value.path) {
      throw new Error("Plugin registry is invalid");
    }
    for (const key of ["entryHash", "manifestHash"] as const) {
      const hash = value[key];
      if (hash !== undefined && (typeof hash !== "string" || !/^[a-f0-9]{64}$/i.test(hash))) {
        throw new Error("Plugin registry is invalid");
      }
    }
  }
  return registry as PluginRegistry;
}

type RegistryWriter = (path: string, data: string) => void;

export function createPluginRegistryStore(
  path: string,
  writeAtomic: RegistryWriter = atomicWriteFileSync,
): PluginRegistryStore {
  return {
    read(): PluginRegistry {
      if (!existsSync(path)) return {};
      try {
        return parseRegistry(readFileSync(path, "utf-8"));
      } catch {
        throw new Error("Plugin registry is invalid");
      }
    },
    write(registry: PluginRegistry): void {
      ensureDirFor(path);
      writeAtomic(path, JSON.stringify(registry, null, 2));
    },
  };
}
