import {
  registeredPluginItem,
  type PluginListItem,
} from "./lifecycle-status.js";
import type { PluginManifest } from "./manifest.js";
import type { PluginRegistry } from "./registry-store.js";
import { requiredSecrets, type SecretBlockedPlugin } from "./secret-requirements.js";
import type { TrustLevel } from "./publisher-trust.js";

interface ListingLoadedPlugin {
  manifest: PluginManifest;
  trustLevel: TrustLevel;
}

export function buildPluginList(
  registry: PluginRegistry,
  loadedPlugins: Map<string, ListingLoadedPlugin>,
  restoreErrors: Map<string, string>,
  secretBlocked: Map<string, SecretBlockedPlugin>,
): PluginListItem[] {
  const ids = new Set([
    ...Object.keys(registry),
    ...loadedPlugins.keys(),
    ...restoreErrors.keys(),
    ...secretBlocked.keys(),
  ]);
  return [...ids].map((id) => {
    const loaded = loadedPlugins.get(id);
    const blocked = secretBlocked.get(id);
    const entry = registry[id];
    const enabled = entry?.enabled ?? loaded !== undefined;
    if (loaded) {
      const error = restoreErrors.get(id);
      return {
        ...loaded.manifest,
        enabled,
        status: "loaded",
        trustLevel: loaded.trustLevel,
        ...(error ? { error } : {}),
      };
    }
    if (blocked) {
      return {
        ...blocked.manifest,
        enabled: entry?.enabled ?? true,
        status: blocked.missingSecrets.length > 0 ? "needs_secrets" : blocked.error ? "failed" : "ready",
        trustLevel: blocked.trustLevel,
        requiredSecrets: requiredSecrets(blocked.manifest),
        missingSecrets: blocked.missingSecrets,
        ...(blocked.error ? { error: blocked.error } : {}),
      };
    }
    return registeredPluginItem(id, enabled, restoreErrors.get(id));
  });
}
