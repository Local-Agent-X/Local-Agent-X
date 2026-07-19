import {
  pluginLifecycleActions,
  pluginListItem,
  type PluginListItem,
} from "./lifecycle-status.js";
import {
  pluginManifestMetadata,
  type PluginManifest,
  type PluginSecretRequirement,
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
  missingFor: (requirements: PluginSecretRequirement[]) => string[] = () => [],
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
        actions: pluginLifecycleActions({ disable: entry?.enabled === true }),
        activeTools: activeTools(registryId),
        error: restoreErrors.get(registryId)?.error,
      });
    }
    if (blocked) {
      const blockedEnabled = entry?.enabled ?? true;
      const pinnedIdentity = entry?.manifest?.id === registryId && !!entry.entryHash && !!entry.manifestHash;
      return pluginListItem({
        registryId,
        manifest: pluginManifestMetadata(blocked.manifest),
        manifestHash: blocked.manifestHash ?? entry?.manifestHash,
        enabled: blockedEnabled,
        status: blocked.missingSecrets.length > 0 ? "needs_secrets" : blocked.error ? "failed" : "ready",
        trustLevel: blocked.trustLevel,
        actions: pluginLifecycleActions({
          enable: !blockedEnabled && blocked.missingSecrets.length === 0 && pinnedIdentity,
          disable: blockedEnabled && entry !== undefined,
          retry: blockedEnabled && blocked.missingSecrets.length === 0,
          configureSecrets: blocked.missingSecrets.length > 0,
        }),
        missingSecrets: blocked.missingSecrets,
        error: blocked.error,
      });
    }
    const failure = restoreErrors.get(registryId);
    const manifest = failure?.manifest ? pluginManifestMetadata(failure.manifest) : entry?.manifest;
    const missingSecrets = missingFor(manifest?.requiredSecrets ?? []);
    const pinnedIdentity = entry?.manifest?.id === registryId && !!entry.entryHash && !!entry.manifestHash;
    const failureIdentity = !failure?.manifest || failure.manifest.id === registryId;
    return pluginListItem({
      registryId,
      manifest,
      manifestHash: failure?.manifestHash ?? entry?.manifestHash,
      enabled,
      status: failure ? "failed" : !enabled ? "disabled" : "registered",
      trustLevel: null,
      actions: pluginLifecycleActions({
        enable: !enabled && pinnedIdentity && failureIdentity && missingSecrets.length === 0,
        disable: enabled && entry !== undefined,
        retry: !!failure && enabled && pinnedIdentity && failureIdentity && missingSecrets.length === 0,
        configureSecrets: entry !== undefined && missingSecrets.length > 0 && failureIdentity,
      }),
      missingSecrets,
      error: failure?.error,
    });
  });
}
