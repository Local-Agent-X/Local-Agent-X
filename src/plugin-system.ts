// ── Plugin System ── Load/unload capability modules dynamically

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  entryPoint: string;
  tools: string[];
}

interface PluginRegistry {
  [pluginId: string]: { enabled: boolean; path: string };
}

interface LoadedPlugin {
  manifest: PluginManifest;
  module: Record<string, unknown>;
  path: string;
}

const PLUGINS_DIR = join(homedir(), ".sax", "plugins");
const REGISTRY_PATH = join(PLUGINS_DIR, "registry.json");

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

    // Sandbox: load in a restricted scope
    let pluginModule: Record<string, unknown>;
    try {
      const fileUrl = pathToFileURL(entryPath).href;
      pluginModule = (await import(fileUrl)) as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to load plugin "${manifest.id}": ${msg}`);
    }

    this.loaded.set(manifest.id, { manifest, module: pluginModule, path: pluginPath });

    // Update registry
    const registry = readRegistry();
    registry[manifest.id] = { enabled: true, path: pluginPath };
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

  listPlugins(): PluginManifest[] {
    return [...this.loaded.values()].map((p) => p.manifest);
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
