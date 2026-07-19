import type { PluginManifest, PluginSecretRequirement } from "./manifest.js";
import type { TrustLevel } from "./publisher-trust.js";

export interface SecretAvailabilityPort {
  has(name: string): boolean;
  onAvailabilityChange?(listener: (change: { type: "available" | "deleted"; name: string }) => void): () => void;
}

export interface SecretBlockedPlugin {
  manifest: PluginManifest;
  path: string;
  trustLevel: TrustLevel;
  missingSecrets: string[];
  manifestHash?: string;
  error?: string;
}

interface LoadedSecretPlugin {
  manifest: PluginManifest;
  path: string;
  trustLevel: TrustLevel;
  manifestHash: string;
}

export class MissingPluginSecretsError extends Error {
  constructor(public readonly pluginId: string, public readonly missingSecrets: string[]) {
    super(`Plugin "${pluginId}" requires secrets: ${missingSecrets.join(", ")}`);
  }
}

export function requiredSecrets(manifest: PluginManifest): PluginSecretRequirement[] {
  return manifest.contributions?.secrets ?? [];
}

export function missingSecrets(
  manifest: PluginManifest,
  availability: SecretAvailabilityPort | undefined,
): string[] {
  return missingRequiredSecrets(requiredSecrets(manifest), availability);
}

function missingRequiredSecrets(
  requirements: PluginSecretRequirement[],
  availability: SecretAvailabilityPort | undefined,
): string[] {
  return requirements
    .filter((item) => !availability?.has(item.name))
    .map((item) => item.name);
}

export class PluginSecretLifecycle {
  readonly blocked = new Map<string, SecretBlockedPlugin>();
  private availability: SecretAvailabilityPort | undefined;
  private retries = new Map<string, Promise<PluginManifest>>();

  bind(availability: SecretAvailabilityPort): void {
    if (this.availability && this.availability !== availability) {
      throw new Error("Plugin secret availability is already bound");
    }
    this.availability = availability;
  }

  missing(requirements: PluginSecretRequirement[]): string[] {
    return missingRequiredSecrets(requirements, this.availability);
  }

  assertAvailable(manifest: PluginManifest, path: string, trustLevel: TrustLevel, manifestHash?: string): void {
    const unavailable = missingSecrets(manifest, this.availability);
    if (unavailable.length === 0) return;
    this.blocked.set(manifest.id, {
      manifest,
      path,
      trustLevel,
      missingSecrets: unavailable,
      ...(manifestHash ? { manifestHash } : {}),
    });
    throw new MissingPluginSecretsError(manifest.id, unavailable);
  }

  clear(id: string): void {
    this.blocked.delete(id);
  }

  retainCandidate(manifest: PluginManifest, path: string, trustLevel: TrustLevel, manifestHash?: string): void {
    this.blocked.set(manifest.id, {
      manifest,
      path,
      trustLevel,
      missingSecrets: missingSecrets(manifest, this.availability),
      ...(manifestHash ? { manifestHash } : {}),
    });
  }

  markFailure(id: string, error: string): boolean {
    const blocked = this.blocked.get(id);
    if (!blocked) return false;
    blocked.missingSecrets = missingSecrets(blocked.manifest, this.availability);
    blocked.error = error;
    return true;
  }

  serializeRetry(id: string, retry: () => Promise<PluginManifest>): Promise<PluginManifest> {
    const active = this.retries.get(id);
    if (active) return active;
    const pending = retry().finally(() => this.retries.delete(id));
    this.retries.set(id, pending);
    return pending;
  }

  async restoreForAddedSecret(name: string, retry: (id: string) => Promise<PluginManifest>): Promise<void> {
    const ids = [...this.blocked.entries()]
      .filter(([, blocked]) => blocked.missingSecrets.includes(name))
      .map(([id]) => id);
    for (const id of ids) {
      const blocked = this.blocked.get(id);
      if (!blocked) continue;
      blocked.missingSecrets = missingSecrets(blocked.manifest, this.availability);
      if (blocked.missingSecrets.length > 0) continue;
      try { await retry(id); } catch { /* lifecycle owner retains a safe failure status */ }
    }
  }

  handleDeletedSecret(
    name: string,
    loaded: Map<string, LoadedSecretPlugin>,
    deactivate: (id: string) => void,
  ): void {
    for (const [id, plugin] of [...loaded]) {
      if (!requiredSecrets(plugin.manifest).some((item) => item.name === name)) continue;
      let error: string | undefined;
      try { deactivate(id); } catch { error = "Plugin tool revocation cleanup failed"; }
      loaded.delete(id);
      this.blocked.set(id, {
        manifest: plugin.manifest,
        path: plugin.path,
        trustLevel: plugin.trustLevel,
        missingSecrets: missingSecrets(plugin.manifest, this.availability),
        manifestHash: plugin.manifestHash,
        ...(error ? { error } : {}),
      });
    }
    for (const blocked of this.blocked.values()) {
      blocked.missingSecrets = missingSecrets(blocked.manifest, this.availability);
    }
  }
}
