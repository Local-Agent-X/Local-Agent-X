import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginRegistryContentError, type PluginRegistry, type PluginRegistryStore } from "../src/plugin-system/registry-store.js";

let root: string;
let pluginsDir: string;
let previousDataDir: string | undefined;

function clone(registry: PluginRegistry): PluginRegistry {
  return structuredClone(registry);
}

function memoryStore(initial: PluginRegistry = {}): PluginRegistryStore & {
  current(): PluginRegistry;
  failNext(stage: "write" | "rename"): void;
  writes(): number;
} {
  let registry = clone(initial);
  let failure: string | undefined;
  let writeCount = 0;
  return {
    read: () => clone(registry),
    write(next) {
      writeCount += 1;
      if (failure) {
        const stage = failure;
        failure = undefined;
        throw new Error(`${stage} failed at C:\\private\\registry.json`);
      }
      registry = clone(next);
    },
    current: () => clone(registry),
    failNext: (stage) => { failure = stage; },
    writes: () => writeCount,
  };
}

function makePlugin(id: string, entry = "export const ready = true;\n"): string {
  const dir = join(pluginsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.mjs"), entry, "utf-8");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    id,
    name: id,
    version: "1.0.0",
    description: "transaction test",
    entryPoint: "index.mjs",
    tools: ["sample_tool"],
  }), "utf-8");
  return dir;
}

function makeToolPlugin(id: string, toolName: string): string {
  const dir = join(pluginsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.mjs"), `
export const ${toolName} = {
  name: ${JSON.stringify(toolName)},
  description: "transaction tool",
  parameters: { type: "object", properties: {}, required: [] },
  async execute() { return { content: "executed" }; }
};
`, "utf-8");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    id,
    name: id,
    version: "1.0.0",
    description: "transaction test",
    entryPoint: "index.mjs",
    contributions: { tools: [toolName] },
  }), "utf-8");
  return dir;
}

async function manager(store: PluginRegistryStore) {
  vi.resetModules();
  const { PluginManager } = await import("../src/plugin-system.js");
  return new PluginManager(store);
}

async function managerWithSurface(store: PluginRegistryStore, toolName: string) {
  vi.resetModules();
  const [{ PluginManager }, { PluginToolSurface }, { UnifiedToolRegistry }, { ToolPolicy }] = await Promise.all([
    import("../src/plugin-system.js"),
    import("../src/plugin-system/tool-surface.js"),
    import("../src/tools/registry.js"),
    import("../src/tool-policy/index.js"),
  ]);
  const registry = new UnifiedToolRegistry();
  const live: Array<import("../src/types.js").ToolDefinition> = [];
  const policy = new ToolPolicy({
    defaultDecision: "deny",
    rules: [{ id: `allow-${toolName}`, tool: toolName, decision: "allow", reason: "test" }],
  });
  const pm = new PluginManager(store);
  pm.bindToolSurface(new PluginToolSurface(registry, live, policy));
  return { pm, registry, live };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "lax-plugin-tx-")));
  pluginsDir = join(root, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  previousDataDir = process.env.LAX_DATA_DIR;
  process.env.LAX_DATA_DIR = root;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = previousDataDir;
  rmSync(root, { recursive: true, force: true });
});

describe("PluginManager lifecycle transactions", () => {
  it("rejects malformed declarative schemas before lifecycle persistence or visibility", async () => {
    const dir = makeToolPlugin("invalid-schema", "invalid_schema_action");
    const entryPath = join(dir, "index.mjs");
    const entry = readFileSync(entryPath, "utf-8").replace(
      'parameters: { type: "object", properties: {}, required: [] }',
      'parameters: { type: "object", properties: "invalid", required: [] }',
    );
    writeFileSync(entryPath, entry, "utf-8");
    const store = memoryStore();
    const { pm, registry, live } = await managerWithSurface(store, "invalid_schema_action");

    await expect(pm.loadPlugin(dir)).rejects.toThrow(/properties/);
    expect(store.writes()).toBe(0);
    expect(registry.get("invalid_schema_action")).toBeUndefined();
    expect(live).toEqual([]);
    expect(pm.listPlugins()).toEqual([
      expect.objectContaining({
        id: "invalid-schema", version: "1.0.0", status: "failed",
        declaredTools: ["invalid_schema_action"], activeTools: [], error: "Plugin tool surface is invalid",
      }),
    ]);
  });

  it("exposes declarative tools only after lifecycle persistence succeeds", async () => {
    const dir = makeToolPlugin("surface-persistence", "persisted_action");
    const store = memoryStore();
    store.failNext("write");
    const { pm, registry, live } = await managerWithSurface(store, "persisted_action");

    await expect(pm.loadPlugin(dir)).rejects.toThrow("Plugin load could not be persisted");
    expect(registry.get("persisted_action")).toBeUndefined();
    expect(live).toEqual([]);
    expect(pm.listPlugins()).toEqual([]);

    await expect(pm.loadPlugin(dir)).resolves.toEqual(expect.objectContaining({ id: "surface-persistence" }));
    expect(registry.get("persisted_action")).toBe(live[0]);
    expect(pm.getPluginModule("surface-persistence")).toBeNull();
    expect(await live[0].execute({})).toEqual({ content: "executed" });
  });

  it("keeps a tool active when disable persistence fails, then revokes stale wrappers", async () => {
    const dir = makeToolPlugin("surface-disable", "disable_action");
    const store = memoryStore();
    const { pm, registry, live } = await managerWithSurface(store, "disable_action");
    await pm.loadPlugin(dir);
    const stale = live[0];
    store.failNext("rename");

    expect(() => pm.disablePlugin("surface-disable")).toThrow("Plugin disable could not be persisted");
    expect(registry.get("disable_action")).toBe(stale);
    expect(await stale.execute({})).toEqual({ content: "executed" });

    expect(pm.disablePlugin("surface-disable")).toBe(true);
    expect(registry.get("disable_action")).toBeUndefined();
    expect(live).toEqual([]);
    expect(await stale.execute({})).toEqual(expect.objectContaining({ status: "blocked", isError: true }));
  });

  it("restores declarative tools once without duplicate live entries", async () => {
    const dir = makeToolPlugin("surface-restore", "restore_action");
    const entry = readFileSync(join(dir, "index.mjs"), "utf-8");
    const manifest = readFileSync(join(dir, "manifest.json"), "utf-8");
    const store = memoryStore({
      "surface-restore": {
        enabled: true,
        path: dir,
        entryHash: createHash("sha256").update(entry).digest("hex"),
        manifestHash: createHash("sha256").update(manifest).digest("hex"),
      },
    });
    const { pm, registry, live } = await managerWithSurface(store, "restore_action");

    await expect(pm.loadAllEnabled()).resolves.toEqual([expect.objectContaining({ id: "surface-restore" })]);
    await expect(pm.loadAllEnabled()).resolves.toEqual([]);
    expect(live.map((tool) => tool.name)).toEqual(["restore_action"]);
    expect(registry.get("restore_action")).toBe(live[0]);
  });

  it.each(["write", "rename"] as const)("does not activate a plugin when registry %s fails", async (stage) => {
    const marker = join(root, `module-${stage}.txt`);
    const dir = makePlugin(
      `failed-${stage}`,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
    );
    const store = memoryStore();
    store.failNext(stage);
    const pm = await manager(store);

    await expect(pm.loadPlugin(dir)).rejects.toThrow("Plugin load could not be persisted");
    expect(pm.isLoaded(`failed-${stage}`)).toBe(false);
    expect(store.current()).toEqual({});
    expect(pm.listPlugins()).toEqual([]);

    expect(readFileSync(marker, "utf-8")).toBe("ran");
    await expect(pm.loadPlugin(dir)).resolves.toEqual(expect.objectContaining({ id: `failed-${stage}` }));
    expect(pm.isLoaded(`failed-${stage}`)).toBe(true);
  });

  it("rolls a failed disable back to the loaded and enabled state, then retries", async () => {
    const dir = makePlugin("disable-rollback");
    const store = memoryStore();
    const pm = await manager(store);
    await pm.loadPlugin(dir);
    store.failNext("rename");

    expect(() => pm.disablePlugin("disable-rollback")).toThrow("Plugin disable could not be persisted");
    expect(pm.isLoaded("disable-rollback")).toBe(true);
    expect(store.current()["disable-rollback"].enabled).toBe(true);
    expect(pm.listPlugins()).toEqual([
      expect.objectContaining({
        id: "disable-rollback",
        enabled: true,
        status: "loaded",
      }),
    ]);

    expect(pm.disablePlugin("disable-rollback")).toBe(true);
    expect(pm.isLoaded("disable-rollback")).toBe(false);
    expect(store.current()["disable-rollback"].enabled).toBe(false);
    expect(store.current()["disable-rollback"].manifest).toMatchObject({ id: "disable-rollback", version: "1.0.0" });
    expect(pm.listPlugins()).toEqual([
      expect.objectContaining({ id: "disable-rollback", status: "disabled", enabled: false }),
    ]);
  });

  it("restores a valid pinned entry without rewriting its authoritative record", async () => {
    const entry = "export const restored = true;\n";
    const dir = makePlugin("valid-restore", entry);
    const manifest = readFileSync(join(dir, "manifest.json"), "utf-8");
    const store = memoryStore({
      "valid-restore": {
        enabled: true,
        path: dir,
        entryHash: createHash("sha256").update(entry).digest("hex"),
        manifestHash: createHash("sha256").update(manifest).digest("hex"),
      },
    });
    const pm = await manager(store);

    await expect(pm.loadAllEnabled()).resolves.toEqual([
      expect.objectContaining({ id: "valid-restore" }),
    ]);
    expect(pm.isLoaded("valid-restore")).toBe(true);
    expect(store.writes()).toBe(0);
  });

  it("does not activate a restore that was disabled while its module imported", async () => {
    const entry = "export const superseded = true;\n";
    const dir = makePlugin("superseded-restore", entry);
    const manifest = readFileSync(join(dir, "manifest.json"), "utf-8");
    const enabled: PluginRegistry = {
      "superseded-restore": {
        enabled: true,
        path: dir,
        entryHash: createHash("sha256").update(entry).digest("hex"),
        manifestHash: createHash("sha256").update(manifest).digest("hex"),
      },
    };
    const disabled = clone(enabled);
    disabled["superseded-restore"].enabled = false;
    let reads = 0;
    const store: PluginRegistryStore = {
      read: () => clone(++reads < 3 ? enabled : disabled),
      write: () => { throw new Error("restore must not rewrite the registry"); },
    };
    const pm = await manager(store);

    expect(await pm.loadAllEnabled()).toEqual([]);
    expect(pm.isLoaded("superseded-restore")).toBe(false);
    expect(pm.listPlugins()).toEqual([
      expect.objectContaining({ id: "superseded-restore", enabled: false, status: "disabled" }),
    ]);
  });

  it("preserves integrity pins when a disabled plugin cannot be re-enabled", async () => {
    const entry = "export const pinned = true;\n";
    const dir = makePlugin("pinned-reenable", entry);
    const manifest = readFileSync(join(dir, "manifest.json"), "utf-8");
    const original = {
      enabled: false,
      path: dir,
      entryHash: createHash("sha256").update(entry).digest("hex"),
      manifestHash: createHash("sha256").update(manifest).digest("hex"),
    };
    const store = memoryStore({ "pinned-reenable": original });
    store.failNext("write");
    const pm = await manager(store);

    await expect(pm.loadPlugin(dir)).rejects.toThrow("Plugin load could not be persisted");
    expect(store.current()["pinned-reenable"]).toEqual(original);
    expect(pm.listPlugins()).toEqual([
      expect.objectContaining({
        id: "pinned-reenable",
        enabled: false,
        status: "disabled",
      }),
    ]);
  });

  it("rejects entry tampering before attempting any lifecycle write", async () => {
    const originalEntry = "export const integrity = true;\n";
    const dir = makePlugin("integrity-first", originalEntry);
    const manifest = readFileSync(join(dir, "manifest.json"), "utf-8");
    const store = memoryStore({
      "integrity-first": {
        enabled: false,
        path: dir,
        entryHash: createHash("sha256").update(originalEntry).digest("hex"),
        manifestHash: createHash("sha256").update(manifest).digest("hex"),
      },
    });
    writeFileSync(join(dir, "index.mjs"), `${originalEntry}// tampered\n`, "utf-8");
    const pm = await manager(store);

    await expect(pm.loadPlugin(dir)).rejects.toThrow(/tampered/i);
    expect(store.writes()).toBe(0);
    expect(pm.isLoaded("integrity-first")).toBe(false);
    expect(pm.listPlugins()).toEqual([
      expect.objectContaining({
        id: "integrity-first",
        status: "failed",
        error: "Integrity verification failed",
      }),
    ]);
  });

  it("contains a corrupt registry at boot and recovers after external repair", async () => {
    const entry = "export const repaired = true;\n";
    const dir = makePlugin("repaired-registry", entry);
    const manifest = readFileSync(join(dir, "manifest.json"), "utf-8");
    const repaired: PluginRegistry = {
      "repaired-registry": {
        enabled: true,
        path: dir,
        entryHash: createHash("sha256").update(entry).digest("hex"),
        manifestHash: createHash("sha256").update(manifest).digest("hex"),
      },
    };
    let corrupt = true;
    const store: PluginRegistryStore = {
      read() {
        if (corrupt) throw new PluginRegistryContentError(new SyntaxError("private registry detail"));
        return clone(repaired);
      },
      write() { throw new Error("test store is read-only"); },
    };
    const pm = await manager(store);

    await expect(pm.loadAllEnabled()).resolves.toEqual([]);
    expect(pm.isLoaded("repaired-registry")).toBe(false);
    expect(pm.listPlugins()).toEqual([
      expect.objectContaining({
        id: "plugin-registry",
        enabled: false,
        status: "failed",
        error: "Plugin registry is invalid",
      }),
    ]);

    corrupt = false;
    await expect(pm.loadAllEnabled()).resolves.toEqual([
      expect.objectContaining({ id: "repaired-registry" }),
    ]);
    expect(pm.listPlugins()).toEqual([
      expect.objectContaining({ id: "repaired-registry", status: "loaded" }),
    ]);
  });
});
