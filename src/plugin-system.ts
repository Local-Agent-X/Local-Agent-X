// ── Plugin System ── Load/unload capability modules dynamically

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { getLaxDir } from "./lax-data-dir.js";
import { pathToFileURL } from "node:url";
import { createHash, verify as cryptoVerify, createPublicKey } from "node:crypto";
import {
  registeredPluginItem,
  safePluginId,
  safeRestoreError,
  type PluginListItem,
} from "./plugin-system/lifecycle-status.js";
import { parsePluginManifest, type PluginManifest } from "./plugin-system/manifest.js";

export type { PluginListItem, PluginLifecycleStatus } from "./plugin-system/lifecycle-status.js";
export type { PluginContributions, PluginManifest } from "./plugin-system/manifest.js";

import { createLogger } from "./logger.js";
const logger = createLogger("plugin-system");

export type TrustLevel = "unsigned" | "hash-verified" | "signed";

export interface TrustedPublisher {
  name: string;
  /** Legacy/default key. Hex-encoded raw Ed25519 public key (32 bytes). */
  publicKey?: string;
  /** Named keys permit rotation without changing publisher identity. */
  publicKeys?: Record<string, string>;
}

export interface TrustedPublishersFile {
  [publisherId: string]: TrustedPublisher;
}

interface PluginRegistry {
  [pluginId: string]: { enabled: boolean; path: string; entryHash?: string; manifestHash?: string };
}

interface LoadedPlugin {
  manifest: PluginManifest;
  module: Record<string, unknown>;
  path: string;
  trustLevel: TrustLevel;
}

const PLUGINS_DIR = join(getLaxDir(), "plugins");
const REGISTRY_PATH = join(PLUGINS_DIR, "registry.json");
const TRUSTED_PUBLISHERS_PATH = join(getLaxDir(), "trusted-publishers.json");

// Fixed SPKI DER prefix for Ed25519 public keys (12 bytes)
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function ensurePluginsDir(): void {
  if (!existsSync(PLUGINS_DIR)) {
    mkdirSync(PLUGINS_DIR, { recursive: true });
  }
}

function readRegistry(): PluginRegistry {
  ensurePluginsDir();
  if (!existsSync(REGISTRY_PATH)) return {};
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function writeRegistry(registry: PluginRegistry): void {
  ensurePluginsDir();
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), "utf-8");
}

export function readTrustedPublishers(): TrustedPublishersFile {
  if (!existsSync(TRUSTED_PUBLISHERS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(TRUSTED_PUBLISHERS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function computeEntryHash(entryFilePath: string): string {
  const content = readFileSync(entryFilePath);
  return createHash("sha256").update(content).digest("hex");
}

function verifyEd25519(
  data: Buffer,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  try {
    const signature = Buffer.from(signatureHex, "hex");
    const rawKey = Buffer.from(publicKeyHex, "hex");
    if (rawKey.length !== 32) return false;
    const spkiDer = Buffer.concat([ED25519_SPKI_PREFIX, rawKey]);
    const keyObject = createPublicKey({ key: spkiDer, format: "der", type: "spki" });
    return cryptoVerify(null, data, keyObject, signature);
  } catch {
    return false;
  }
}

export type PublisherSignatureVerdict =
  | { status: "valid"; publisher: TrustedPublisher; keyId: string | null }
  | { status: "unknown-publisher" }
  | { status: "unknown-key"; publisher: TrustedPublisher }
  | { status: "invalid"; publisher: TrustedPublisher; keyId: string | null };

/** Shared Ed25519 publisher verifier used by plugins and signed MCP manifests. */
export function verifyPublisherSignature(
  publisherId: string,
  data: Buffer,
  signatureHex: string,
  keyId?: string,
): PublisherSignatureVerdict {
  const publisher = readTrustedPublishers()[publisherId];
  if (!publisher) return { status: "unknown-publisher" };

  let publicKey: string | undefined;
  let resolvedKeyId: string | null = null;
  if (keyId) {
    publicKey = publisher.publicKeys?.[keyId];
    resolvedKeyId = keyId;
    if (!publicKey) return { status: "unknown-key", publisher };
  } else if (publisher.publicKey) {
    publicKey = publisher.publicKey;
  } else {
    const keys = Object.entries(publisher.publicKeys ?? {});
    if (keys.length !== 1) return { status: "unknown-key", publisher };
    [resolvedKeyId, publicKey] = keys[0];
  }

  return verifyEd25519(data, signatureHex, publicKey)
    ? { status: "valid", publisher, keyId: resolvedKeyId }
    : { status: "invalid", publisher, keyId: resolvedKeyId };
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

    const currentManifestHash = createHash("sha256").update(manifestContent).digest("hex");
    const registry = readRegistry();
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

    this.loaded.set(manifest.id, {
      manifest,
      module: pluginModule,
      path: pluginPath,
      trustLevel: trust.trustLevel,
    });
    this.restoreErrors.delete(manifest.id);

    // Persist registry with hash pin
    registry[manifest.id] = {
      enabled: true,
      path: pluginPath,
      entryHash: trust.currentHash,
      manifestHash: currentManifestHash,
    };
    writeRegistry(registry);

    return manifest;
  }

  disablePlugin(id: string): boolean {
    const registry = readRegistry();
    if (!registry[id]) return false;
    this.loaded.delete(id);
    this.restoreErrors.delete(id);
    registry[id].enabled = false;
    writeRegistry(registry);
    return true;
  }

  listPlugins(): PluginListItem[] {
    const registry = readRegistry();
    const ids = new Set([...Object.keys(registry), ...this.loaded.keys()]);
    return [...ids].map<PluginListItem>((id) => {
      const loaded = this.loaded.get(id);
      const entry = registry[id];
      const enabled = entry?.enabled ?? loaded !== undefined;
      if (loaded) {
        return { ...loaded.manifest, enabled, status: "loaded", trustLevel: loaded.trustLevel };
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
    const registry = readRegistry();
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
        results.push(manifest);
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
