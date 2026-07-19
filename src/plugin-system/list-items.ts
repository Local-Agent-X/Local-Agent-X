import {
  pluginListItem,
  type PluginListItem,
} from "./lifecycle-status.js";
import {
  pluginManifestMetadata,
  type PluginManifest,
} from "./manifest.js";
import type { PluginRegistry } from "./registry-store.js";
import type { SecretBlockedPlugin } from "./secret-requirements.js";
import type { ActivePluginToolProjection } from "./tool-surface.js";
import type { TrustLevel } from "./publisher-trust.js";

interface ListingLoadedPlugin {
  manifest: PluginManifest;
  trustLevel: TrustLevel;
  manifestHash: string;
}

export interface PluginRestoreFailure {
  error: string;
  manifest?: PluginManifest;
  manifestHash?: string;
}

export function buildPluginList(
  registry: PluginRegistry,
  loadedPlugins: Map<string, ListingLoadedPlugin>,
  restoreErrors: Map<string, PluginRestoreFailure>,
  secretBlocked: Map<string, SecretBlockedPlugin>,
  activeTools: (id: string) => ActivePluginToolProjection[] = () => [],
): PluginListItem[] {
  const ids = new Set([
    ...Object.keys(registry),
    ...loadedPlugins.keys(),
    ...restoreErrors.keys(),
    ...secretBlocked.keys(),
  ]);
  return [...ids].sort().map((registryId) => {
    const loaded = loadedPlugins.get(registryId);
    const blocked = secretBlocked.get(registryId);
    const entry = registry[registryId];
    const enabled = entry?.enabled ?? loaded !== undefined;
    if (loaded) {
      return pluginListItem({
        registryId,
        manifest: pluginManifestMetadata(loaded.manifest),
        manifestHash: loaded.manifestHash,
        enabled,
        status: "loaded",
        trustLevel: loaded.trustLevel,
        activeTools: activeTools(registryId),
        error: restoreErrors.get(registryId)?.error,
      });
    }
    if (blocked) {
      return pluginListItem({
        registryId,
        manifest: pluginManifestMetadata(blocked.manifest),
        manifestHash: blocked.manifestHash ?? entry?.manifestHash,
        enabled: entry?.enabled ?? true,
        status: blocked.missingSecrets.length > 0 ? "needs_secrets" : blocked.error ? "failed" : "ready",
        trustLevel: blocked.trustLevel,
        missingSecrets: blocked.missingSecrets,
        error: blocked.error,
      });
    }
    const failure = restoreErrors.get(registryId);
    return pluginListItem({
      registryId,
      manifest: failure?.manifest ? pluginManifestMetadata(failure.manifest) : entry?.manifest,
      manifestHash: failure?.manifestHash ?? entry?.manifestHash,
      enabled,
      status: failure ? "failed" : !enabled ? "disabled" : "registered",
      trustLevel: null,
      error: failure?.error,
    });
  });
}
