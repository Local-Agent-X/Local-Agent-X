// ── Plugin System ── Load/unload capability modules dynamically

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { getLaxDir } from "./lax-data-dir.js";
import { pathToFileURL } from "node:url";
import { createHash, verify as cryptoVerify, createPublicKey } from "node:crypto";

import { createLogger } from "./logger.js";
const logger = createLogger("plugin-system");

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  entryPoint: string;
  tools: string[];
  signature?: string;   // hex-encoded Ed25519 signature over the entry point content
  publisher?: string;    // publisher ID, maps to key in trusted-publishers.json
}

export type TrustLevel = "unsigned" | "hash-verified" | "signed";

interface TrustedPublisher {
  name: string;
  publicKey: string; // hex-encoded raw Ed25519 public key (32 bytes = 64 hex chars)
}

interface TrustedPublishersFile {
  [publisherId: string]: TrustedPublisher;
}

interface PluginRegistry {
  [pluginId: string]: { enabled: boolean; path: string; entryHash?: string };
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

function readTrustedPublishers(): TrustedPublishersFile {
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

function verifySignature(
  entryFilePath: string,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  try {
    const data = readFileSync(entryFilePath);
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
    const publishers = readTrustedPublishers();
    const pub = publishers[manifest.publisher];
    if (pub) {
      const valid = verifySignature(entryFilePath, manifest.signature, pub.publicKey);
      if (valid) {
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

function validateManifest(data: unknown): data is PluginManifest {
  if (!data || typeof data !== "object") return false;
  const m = data as Record<string, unknown>;
  if (typeof m.id !== "string" || !m.id.trim()) return false;
  if (typeof m.name !== "string" || !m.name.trim()) return false;
  if (typeof m.version !== "string" || !m.version.trim()) return false;
  if (typeof m.description !== "string") return false;
  if (typeof m.entryPoint !== "string" || !m.entryPoint.trim()) return false;
  if (!Array.isArray(m.tools)) return false;
  for (const t of m.tools) {
    if (typeof t !== "string") return false;
  }
  // Optional signature fields
  if (m.signature !== undefined && typeof m.signature !== "string") return false;
  if (m.publisher !== undefined && typeof m.publisher !== "string") return false;
  if (m.signature && !m.publisher) return false;
  if (typeof m.publisher === "string" && !/^[a-zA-Z0-9._-]+$/.test(m.publisher)) return false;
  if (typeof m.signature === "string" && !/^[a-f0-9]+$/i.test(m.signature)) return false;
  return true;
}

export class PluginManager {
  private loaded = new Map<string, LoadedPlugin>();

  async loadPlugin(pluginPath: string): Promise<PluginManifest> {
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
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch {
      throw new Error(`Invalid JSON in manifest at ${manifestPath}`);
    }

    if (!validateManifest(raw)) {
      throw new Error(
        `Invalid manifest at ${manifestPath}. ` +
          "Required fields: id, name, version, description, entryPoint, tools[]"
      );
    }

    const manifest = raw;

    if (this.loaded.has(manifest.id)) {
      throw new Error(`Plugin "${manifest.id}" is already loaded`);
    }

    const entryPath = join(pluginPath, manifest.entryPoint);
    if (!existsSync(entryPath)) {
      throw new Error(`Entry point not found: ${entryPath}`);
    }

    // ── Integrity & signature verification ──
    const registry = readRegistry();
    const registeredHash = registry[manifest.id]?.entryHash;

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

    // Persist registry with hash pin
    registry[manifest.id] = {
      enabled: true,
      path: pluginPath,
      entryHash: trust.currentHash,
    };
    writeRegistry(registry);

    return manifest;
  }

  unloadPlugin(id: string): void {
    if (!this.loaded.has(id)) {
      throw new Error(`Plugin "${id}" is not loaded`);
    }
    this.loaded.delete(id);

    const registry = readRegistry();
    if (registry[id]) {
      registry[id].enabled = false;
      writeRegistry(registry);
    }
  }

  listPlugins(): Array<PluginManifest & { trustLevel: TrustLevel }> {
    return [...this.loaded.values()].map((p) => ({
      ...p.manifest,
      trustLevel: p.trustLevel,
    }));
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
      try {
        const manifest = await this.loadPlugin(entry.path);
        results.push(manifest);
      } catch {
        // Skip plugins that fail to load on startup
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
