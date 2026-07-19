import { readFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { getLaxDir } from "./lax-data-dir.js";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { registeredPluginItem, safeLifecyclePersistenceError, safePluginId, safeRestoreError, type PluginListItem } from "./plugin-system/lifecycle-status.js";
import { parsePluginManifest, pluginManifestMetadata, type PluginManifest } from "./plugin-system/manifest.js";
import { createPluginRegistryStore, type PluginRegistry, type PluginRegistryStore } from "./plugin-system/registry-store.js";
import { verifyPublisherSignature, type TrustLevel } from "./plugin-system/publisher-trust.js";
import { assessTrustLevel } from "./plugin-system/integrity.js";
import { buildPluginList } from "./plugin-system/list-items.js";
import type { PluginRestoreFailure } from "./plugin-system/list-items.js";
import { MissingPluginSecretsError, PluginSecretLifecycle, type SecretAvailabilityPort } from "./plugin-system/secret-requirements.js";
import type { PluginToolSurfacePort, PreparedPluginToolActivation } from "./plugin-system/tool-surface.js";
export type { PluginListItem, PluginLifecycleStatus } from "./plugin-system/lifecycle-status.js";
export type { PluginContributions, PluginManifest } from "./plugin-system/manifest.js";
export { readTrustedPublishers, verifyPublisherSignature, type PublisherSignatureVerdict, type TrustedPublisher, type TrustedPublishersFile, type TrustLevel } from "./plugin-system/publisher-trust.js";
import { createLogger } from "./logger.js";
const logger = createLogger("plugin-system");
interface LoadedPlugin {
  manifest: PluginManifest;
  module: Record<string, unknown>;
  path: string;
  trustLevel: TrustLevel;
  manifestHash: string;
}
const PLUGINS_DIR = join(getLaxDir(), "plugins");
const REGISTRY_PATH = join(PLUGINS_DIR, "registry.json");
function ensurePluginsDir(): void {
  if (!existsSync(PLUGINS_DIR)) mkdirSync(PLUGINS_DIR, { recursive: true });
}
export class PluginManager {
  private loaded = new Map<string, LoadedPlugin>();
  private restoreErrors = new Map<string, PluginRestoreFailure>();
  private registryError: string | undefined;
  private toolSurface: PluginToolSurfacePort | undefined;
  private secretLifecycle = new PluginSecretLifecycle();
  constructor(private registryStore: PluginRegistryStore = createPluginRegistryStore(REGISTRY_PATH)) {}
  private readRegistry(): PluginRegistry {
    try { const registry = this.registryStore.read(); this.registryError = undefined; return registry; }
    catch {
      this.registryError = "Plugin registry is invalid";
      for (const id of this.loaded.keys()) {
        try { this.toolSurface?.deactivate(id); } catch { /* canonical surface revokes before reporting cleanup errors */ }
        this.secretLifecycle.clear(id);
      }
      this.loaded.clear();
      throw new Error(this.registryError);
    }
  }
  bindToolSurface(surface: PluginToolSurfacePort): void {
    if (this.toolSurface && this.toolSurface !== surface) throw new Error("Plugin tool surface is already bound");
    this.toolSurface = surface;
  }
  bindSecretAvailability(availability: SecretAvailabilityPort): void {
    this.secretLifecycle.bind(availability);
    availability.onAvailabilityChange?.((change) => {
      if (change.type === "deleted") this.onSecretDeleted(change.name);
      else void this.onSecretAdded(change.name);
    });
  }
  async loadPlugin(pluginPath: string): Promise<PluginManifest> { return this.loadPluginAtPath(pluginPath); }
  private async loadPluginAtPath(pluginPath: string,
    expectedRegistration?: { id: string; entryHash: string; manifestHash?: string; enable?: boolean },
    inspectSecretRequirements = false): Promise<PluginManifest> {
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
    let preparedTools: PreparedPluginToolActivation | null = null;
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
      throw new Error(`Invalid manifest at ${manifestPath}. ` +
        "Required fields: id, name, version, description, entryPoint, and tools[] or contributions.tools[]");
    }
    if (expectedRegistration && manifest.id !== expectedRegistration.id) {
      throw new Error(`Registered plugin ID "${expectedRegistration.id}" does not match manifest ID`);
    }
    if (inspectSecretRequirements && !manifest.contributions?.secrets?.length) return manifest;

    const currentManifestHash = createHash("sha256").update(manifestContent).digest("hex");
    try {
    const registry = this.readRegistry();
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

    if (!expectedRegistration && manifest.contributions?.secrets?.length) {
      this.secretLifecycle.retainCandidate(manifest, pluginPath, trust.trustLevel, currentManifestHash);
    }
    if (inspectSecretRequirements) return manifest;
    try { this.secretLifecycle.assertAvailable(manifest, pluginPath, trust.trustLevel, currentManifestHash); }
    catch (error) {
      if (error instanceof MissingPluginSecretsError) this.restoreErrors.delete(manifest.id);
      throw error;
    }

    let pluginModule: Record<string, unknown>;
    try {
      const fileUrl = pathToFileURL(entryPath).href;
      pluginModule = (await import(fileUrl)) as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to load plugin "${manifest.id}": ${msg}`);
    }

    const executableProvenance = createHash("sha256")
      .update(`plugin:${manifest.id}\nmanifest:${currentManifestHash}\nentry:${trust.currentHash}`)
      .digest("hex");
    preparedTools = this.toolSurface?.prepare(manifest.id, manifest, pluginModule, executableProvenance) ?? null;
    this.secretLifecycle.assertAvailable(manifest, pluginPath, trust.trustLevel, currentManifestHash);

    const loadedPlugin: LoadedPlugin = {
      manifest, module: pluginModule, path: pluginPath,
      trustLevel: trust.trustLevel, manifestHash: currentManifestHash,
    };

    if (!expectedRegistration) {
      try {
        const nextRegistry: PluginRegistry = {
          ...this.readRegistry(),
          [manifest.id]: {
            enabled: true,
            path: pluginPath,
            entryHash: trust.currentHash,
            manifestHash: currentManifestHash,
            manifest: pluginManifestMetadata(manifest),
          },
        };
        this.registryStore.write(nextRegistry);
      } catch {
        const reason = safeLifecyclePersistenceError("load");
        this.restoreErrors.set(manifest.id, { error: reason, manifest, manifestHash: currentManifestHash });
        throw new Error(reason);
      }
    } else {
      const currentRegistry = this.readRegistry();
      const current = currentRegistry[manifest.id];
      const unchanged = current?.path === pluginPath &&
        current.entryHash === expectedRegistration.entryHash &&
        current.manifestHash === expectedRegistration.manifestHash;
      if (expectedRegistration.enable) {
        if (!current || !unchanged || current.enabled) throw new Error("Plugin lifecycle state changed during enable");
        try {
          this.registryStore.write({
            ...currentRegistry,
            [manifest.id]: { ...current, enabled: true, manifest: pluginManifestMetadata(manifest) },
          });
        } catch { throw new Error(safeLifecyclePersistenceError("load")); }
      }
      if (
        (!expectedRegistration.enable && !current?.enabled) || !unchanged
      ) {
        if (preparedTools) this.toolSurface?.abort(preparedTools);
        return manifest;
      }
    }

    if (preparedTools) this.toolSurface?.activate(preparedTools);
    this.loaded.set(manifest.id, loadedPlugin);
    this.secretLifecycle.clear(manifest.id);
    this.restoreErrors.delete(manifest.id);

    return manifest;
    } catch (error) {
      if (preparedTools) this.toolSurface?.abort(preparedTools);
      if (!(error instanceof MissingPluginSecretsError) && (!expectedRegistration || expectedRegistration.enable) && !this.loaded.has(manifest.id)) {
        const reason = safeRestoreError(error);
        if (!this.secretLifecycle.markFailure(manifest.id, reason)) {
          this.restoreErrors.set(manifest.id, { error: reason, manifest, manifestHash: currentManifestHash });
        }
      }
      throw error;
    }
  }

  disablePlugin(id: string): boolean {
    const registry = this.readRegistry();
    if (!registry[id]) return false;
    const loaded = this.loaded.get(id);
    const nextRegistry: PluginRegistry = {
      ...registry,
      [id]: {
        ...registry[id],
        enabled: false,
        ...(loaded ? { manifest: pluginManifestMetadata(loaded.manifest), manifestHash: loaded.manifestHash } : {}),
      },
    };
    try {
      this.registryStore.write(nextRegistry);
    } catch {
      this.restoreErrors.set(id, {
        error: safeLifecyclePersistenceError("disable"),
        ...(loaded ? { manifest: loaded.manifest, manifestHash: loaded.manifestHash } : {}),
      });
      throw new Error(safeLifecyclePersistenceError("disable"));
    }
    this.loaded.delete(id);
    this.secretLifecycle.clear(id);
    this.toolSurface?.deactivate(id);
    this.restoreErrors.delete(id);
    return true;
  }
  listPlugins(): PluginListItem[] {
    let registry: PluginRegistry;
    try {
      registry = this.readRegistry();
    } catch {
      this.registryError = "Plugin registry is invalid";
      logger.warn("[plugin] Plugin registry is invalid; lifecycle operations are unavailable");
      return [registeredPluginItem("plugin-registry", false, this.registryError)];
    }
    return buildPluginList(registry, this.loaded, this.restoreErrors, this.secretLifecycle.blocked,
      (id) => this.toolSurface?.listActive(id) ?? [], (requirements) => this.secretLifecycle.missing(requirements));
  }

  getPluginStatus(id: string): PluginListItem | undefined {
    return this.listPlugins().find((plugin) => plugin.registryId === id);
  }
  getPluginTools(id: string): string[] {
    const plugin = this.loaded.get(id);
    if (!plugin) {
      throw new Error(`Plugin "${id}" is not loaded`);
    }
    return [...plugin.manifest.tools];
  }

  getActivePluginTools(id: string): string[] {
    return (this.toolSurface?.listActive(id) ?? []).map((tool) => tool.name);
  }
  getPluginModule(id: string): Record<string, unknown> | null {
    const plugin = this.loaded.get(id);
    if (!plugin || plugin.manifest.contributions?.tools) return null;
    return plugin.module;
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
      registry = this.readRegistry();
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
        this.restoreErrors.set(id, { error: reason });
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
        if (error instanceof MissingPluginSecretsError) continue;
        const reason = safeRestoreError(error);
        this.restoreErrors.set(id, { error: reason });
        logger.warn(`[plugin] Restore failed for ${safePluginId(id)}: ${reason}`);
      }
    }
    return results;
  }

  async discoverSecretRequirements(): Promise<void> {
    let registry: PluginRegistry;
    try { registry = this.readRegistry(); } catch { return; }
    for (const path of this.discoverPlugins()) {
      try {
        const raw = JSON.parse(readFileSync(join(path, "manifest.json"), "utf-8")) as unknown;
        const manifest = parsePluginManifest(raw);
        if (registry[manifest.id]?.enabled === false || this.loaded.has(manifest.id)) continue;
        await this.loadPluginAtPath(path, undefined, true);
      } catch (error) {
        if (!(error instanceof MissingPluginSecretsError)) continue;
      }
    }
  }

  async retryPlugin(id: string): Promise<PluginManifest> {
    try {
      return await this.secretLifecycle.serializeRetry(id, () => this.retryPluginNow(id));
    } catch (error) {
      if (!(error instanceof MissingPluginSecretsError)) {
        const reason = safeRestoreError(error);
        if (!this.secretLifecycle.markFailure(id, reason)) this.restoreErrors.set(id, { error: reason });
      }
      throw error;
    }
  }
  async enablePlugin(id: string): Promise<PluginManifest> {
    return this.secretLifecycle.serializeRetry(id, async () => {
      const entry = this.readRegistry()[id];
      if (!entry || entry.enabled) throw new Error(`Plugin "${id}" is not disabled`);
      if (entry.manifest?.id !== id || !entry.entryHash || !entry.manifestHash) {
        throw new Error("Plugin is not fully integrity-pinned");
      }
      return this.loadPluginAtPath(entry.path, {
        id, entryHash: entry.entryHash, manifestHash: entry.manifestHash, enable: true,
      });
    });
  }

  private async retryPluginNow(id: string): Promise<PluginManifest> {
    const loaded = this.loaded.get(id);
    if (loaded) return loaded.manifest;
    const blocked = this.secretLifecycle.blocked.get(id);
    const entry = this.readRegistry()[id];
    const path = blocked?.path ?? entry?.path;
    if (!path) throw new Error(`Plugin "${id}" is not waiting for secrets`);
    if (entry?.enabled === false) throw new Error(`Plugin "${id}" is disabled`);
    if (entry?.enabled) {
      if (!entry.entryHash) throw new Error("Plugin is not integrity-pinned");
      return this.loadPluginAtPath(path, {
        id,
        entryHash: entry.entryHash,
        manifestHash: entry.manifestHash,
      });
    }
    return this.loadPluginAtPath(path);
  }

  async onSecretAdded(name: string): Promise<void> {
    await this.secretLifecycle.restoreForAddedSecret(name, (id) => this.retryPlugin(id));
  }
  onSecretDeleted(name: string): void {
    this.secretLifecycle.handleDeletedSecret(name, this.loaded, (id) => this.toolSurface?.deactivate(id));
  }

  discoverPlugins(): string[] {
    ensurePluginsDir();
    return readdirSync(PLUGINS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(PLUGINS_DIR, e.name))
      .filter((dir) => existsSync(join(dir, "manifest.json")));
  }
}
export const pluginManager = new PluginManager();
