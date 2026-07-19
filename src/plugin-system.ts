// ── Plugin System ── Load/unload capability modules dynamically

import { readFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { getLaxDir } from "./lax-data-dir.js";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import {
  registeredPluginItem,
  safeLifecyclePersistenceError,
  safePluginId,
  safeRestoreError,
  type PluginListItem,
} from "./plugin-system/lifecycle-status.js";
import { parsePluginManifest, type PluginManifest } from "./plugin-system/manifest.js";
import {
  createPluginRegistryStore,
  type PluginRegistry,
  type PluginRegistryStore,
} from "./plugin-system/registry-store.js";
import { verifyPublisherSignature, type TrustLevel } from "./plugin-system/publisher-trust.js";

export type { PluginListItem, PluginLifecycleStatus } from "./plugin-system/lifecycle-status.js";
export type { PluginContributions, PluginManifest } from "./plugin-system/manifest.js";
export {
  readTrustedPublishers,
  verifyPublisherSignature,
  type PublisherSignatureVerdict,
  type TrustedPublisher,
  type TrustedPublishersFile,
  type TrustLevel,
} from "./plugin-system/publisher-trust.js";

import { createLogger } from "./logger.js";
const logger = createLogger("plugin-system");

interface LoadedPlugin {
  manifest: PluginManifest;
  module: Record<string, unknown>;
  path: string;
  trustLevel: TrustLevel;
}

const PLUGINS_DIR = join(getLaxDir(), "plugins");
const REGISTRY_PATH = join(PLUGINS_DIR, "registry.json");

function ensurePluginsDir(): void {
  if (!existsSync(PLUGINS_DIR)) {
    mkdirSync(PLUGINS_DIR, { recursive: true });
  }
}

function computeEntryHash(entryFilePath: string): string {
  const content = readFileSync(entryFilePath);
  return createHash("sha256").update(content).digest("hex");
}

function assessTrustLevel(
  manifest: PluginManifest,
  entryFilePath: string,
  registeredHash: string | undefined,
): { trustLevel: TrustLevel; currentHash: string; warning?: string } {
  const currentHash = computeEntryHash(entryFilePath);

  // Tamper check: stored hash must match current file
  if (registeredHash && registeredHash !== currentHash) {
    throw new Error(
      `Plugin "${manifest.id}" entry point has been tampered with. ` +
      `Expected hash ${registeredHash.slice(0, 12)}..., got ${currentHash.slice(0, 12)}.... ` +
      `If this is intentional, remove and reinstall the plugin.`,
    );
  }

  // Check publisher signature
  if (manifest.signature && manifest.publisher) {
    const verdict = verifyPublisherSignature(
      manifest.publisher,
      readFileSync(entryFilePath),
      manifest.signature,
      manifest.keyId,
    );
    if (verdict.status !== "unknown-publisher") {
      if (verdict.status === "valid") {
        return { trustLevel: "signed", currentHash };
      }
      throw new Error(
        `Plugin "${manifest.id}" has an invalid signature from publisher "${manifest.publisher}". ` +
        `The plugin may have been tampered with.`,
      );
    }
    return {
      trustLevel: "unsigned",
      currentHash,
      warning: `Plugin "${manifest.id}" is signed by unknown publisher "${manifest.publisher}". ` +
        `Add them to ~/.lax/trusted-publishers.json to verify.`,
    };
  }

  // No signature — check if we have a stored hash match
  if (registeredHash) {
    return { trustLevel: "hash-verified", currentHash };
  }

  // First load, no signature
  return {
    trustLevel: "unsigned",
    currentHash,
    warning: `Plugin "${manifest.id}" is unsigned. Loading unsigned plugins is a security risk.`,
  };
}

export class PluginManager {
  private loaded = new Map<string, LoadedPlugin>();
  private restoreErrors = new Map<string, string>();
  private registryError: string | undefined;

  constructor(private registryStore: PluginRegistryStore = createPluginRegistryStore(REGISTRY_PATH)) {}

  async loadPlugin(pluginPath: string): Promise<PluginManifest> { return this.loadPluginAtPath(pluginPath); }

  private async loadPluginAtPath(pluginPath: string, expectedRegistration?: { id: string; entryHash: string; manifestHash?: string }): Promise<PluginManifest> {
    // Security: restrict plugins to the designated plugins directory
    const resolvedPath = resolve(pluginPath);
    const realPluginsDir = realpathSync(PLUGINS_DIR);
    const rel = relative(realPluginsDir, resolvedPath);
    if (rel.startsWith("..") || relative(realPluginsDir, resolvedPath) !== rel) {
      throw new Error(`Plugin path must be within ${PLUGINS_DIR}. Got: ${pluginPath}`);
    }

    const manifestPath = join(resolvedPath, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`No manifest.json found at ${pluginPath}`);
    }

    let raw: unknown;
    let manifestContent: string;
    try {
      manifestContent = readFileSync(manifestPath, "utf-8");
      raw = JSON.parse(manifestContent);
    } catch {
      throw new Error(`Invalid JSON in manifest at ${manifestPath}`);
    }

    let manifest: PluginManifest;
    try {
      manifest = parsePluginManifest(raw);
    } catch {
      throw new Error(
        `Invalid manifest at ${manifestPath}. ` +
          "Required fields: id, name, version, description, entryPoint, and tools[] or contributions.tools[]"
      );
    }
    if (expectedRegistration && manifest.id !== expectedRegistration.id) {
      throw new Error(`Registered plugin ID "${expectedRegistration.id}" does not match manifest ID`);
    }

    try {
    const currentManifestHash = createHash("sha256").update(manifestContent).digest("hex");
    const registry = this.registryStore.read();
    const registeredManifestHash = expectedRegistration?.manifestHash ?? registry[manifest.id]?.manifestHash;
    if (expectedRegistration && manifest.contributions && !registeredManifestHash) {
      throw new Error(`Plugin bundle "${manifest.id}" manifest is not integrity-pinned`);
    }
    if (registeredManifestHash && registeredManifestHash !== currentManifestHash) {
      throw new Error(`Plugin "${manifest.id}" manifest has been tampered with`);
    }

    if (this.loaded.has(manifest.id)) {
      throw new Error(`Plugin "${manifest.id}" is already loaded`);
    }

    const entryPath = join(pluginPath, manifest.entryPoint);
    if (!existsSync(entryPath)) {
      throw new Error(`Entry point not found: ${entryPath}`);
    }

    // ── Integrity & signature verification ──
    const registeredHash = expectedRegistration?.entryHash ?? registry[manifest.id]?.entryHash;

    const trust = assessTrustLevel(manifest, entryPath, registeredHash);

    if (trust.warning) {
      logger.warn(`  [plugin] ${trust.warning}`);
    }

    if (trust.trustLevel === "unsigned") {
      logger.warn(
        `  [plugin] WARNING: Loading unsigned plugin "${manifest.id}". ` +
        `In production, this will require explicit user confirmation.`,
      );
    }

    // Load plugin module
    let pluginModule: Record<string, unknown>;
    try {
      const fileUrl = pathToFileURL(entryPath).href;
      pluginModule = (await import(fileUrl)) as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to load plugin "${manifest.id}": ${msg}`);
    }

    const loadedPlugin: LoadedPlugin = {
      manifest,
      module: pluginModule,
      path: pluginPath,
      trustLevel: trust.trustLevel,
    };

    if (!expectedRegistration) {
      try {
        const nextRegistry: PluginRegistry = {
          ...this.registryStore.read(),
          [manifest.id]: {
            enabled: true,
            path: pluginPath,
            entryHash: trust.currentHash,
            manifestHash: currentManifestHash,
          },
        };
        this.registryStore.write(nextRegistry);
      } catch {
        const reason = safeLifecyclePersistenceError("load");
        this.restoreErrors.set(manifest.id, reason);
        throw new Error(reason);
      }
    } else {
      const current = this.registryStore.read()[manifest.id];
      if (
        !current?.enabled ||
        current.path !== pluginPath ||
        current.entryHash !== expectedRegistration.entryHash ||
        current.manifestHash !== expectedRegistration.manifestHash
      ) return manifest;
    }

    this.loaded.set(manifest.id, loadedPlugin);
    this.restoreErrors.delete(manifest.id);

    return manifest;
    } catch (error) {
      if (!expectedRegistration && !this.loaded.has(manifest.id)) {
        this.restoreErrors.set(manifest.id, safeRestoreError(error));
      }
      throw error;
    }
  }

  disablePlugin(id: string): boolean {
    const registry = this.registryStore.read();
    if (!registry[id]) return false;
    const nextRegistry: PluginRegistry = {
      ...registry,
      [id]: { ...registry[id], enabled: false },
    };
    try {
      this.registryStore.write(nextRegistry);
    } catch {
      this.restoreErrors.set(id, safeLifecyclePersistenceError("disable"));
      throw new Error(safeLifecyclePersistenceError("disable"));
    }
    this.loaded.delete(id);
    this.restoreErrors.delete(id);
    return true;
  }

  listPlugins(): PluginListItem[] {
    let registry: PluginRegistry;
    try {
      registry = this.registryStore.read();
      this.registryError = undefined;
    } catch {
      this.registryError = "Plugin registry is invalid";
      logger.warn("[plugin] Plugin registry is invalid; lifecycle operations are unavailable");
      return [registeredPluginItem("plugin-registry", false, this.registryError)];
    }
    const ids = new Set([...Object.keys(registry), ...this.loaded.keys(), ...this.restoreErrors.keys()]);
    return [...ids].map<PluginListItem>((id) => {
      const loaded = this.loaded.get(id);
      const entry = registry[id];
      const enabled = entry?.enabled ?? loaded !== undefined;
      if (loaded) {
        const error = this.restoreErrors.get(id);
        return {
          ...loaded.manifest,
          enabled,
          status: "loaded",
          trustLevel: loaded.trustLevel,
          ...(error ? { error } : {}),
        };
      }
      return registeredPluginItem(id, enabled, this.restoreErrors.get(id));
    });
  }

  getPluginTools(id: string): string[] {
    const plugin = this.loaded.get(id);
    if (!plugin) {
      throw new Error(`Plugin "${id}" is not loaded`);
    }
    return [...plugin.manifest.tools];
  }

  getPluginModule(id: string): Record<string, unknown> | null {
    return this.loaded.get(id)?.module ?? null;
  }

  isLoaded(id: string): boolean {
    return this.loaded.has(id);
  }

  getPluginTrust(id: string): TrustLevel | null {
    return this.loaded.get(id)?.trustLevel ?? null;
  }

  async loadAllEnabled(): Promise<PluginManifest[]> {
    let registry: PluginRegistry;
    try {
      registry = this.registryStore.read();
      this.registryError = undefined;
    } catch {
      this.registryError = "Plugin registry is invalid";
      logger.warn("[plugin] Plugin registry is invalid; enabled plugins were not restored");
      return [];
    }
    const results: PluginManifest[] = [];
    for (const [id, entry] of Object.entries(registry)) {
      if (!entry.enabled) continue;
      if (this.loaded.has(id)) continue;
      if (!entry.entryHash) {
        const reason = "Plugin is not integrity-pinned";
        this.restoreErrors.set(id, reason);
        logger.warn(`[plugin] Restore skipped for ${safePluginId(id)}: ${reason}`);
        continue;
      }
      try {
        const manifest = await this.loadPluginAtPath(entry.path, {
          id,
          entryHash: entry.entryHash,
          manifestHash: entry.manifestHash,
        });
        if (this.loaded.has(id)) results.push(manifest);
      } catch (error) {
        const reason = safeRestoreError(error);
        this.restoreErrors.set(id, reason);
        logger.warn(`[plugin] Restore failed for ${safePluginId(id)}: ${reason}`);
      }
    }
    return results;
  }

  discoverPlugins(): string[] {
    ensurePluginsDir();
    const entries = readdirSync(PLUGINS_DIR, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => join(PLUGINS_DIR, e.name))
      .filter((dir) => existsSync(join(dir, "manifest.json")));
  }
}

export const pluginManager = new PluginManager();
