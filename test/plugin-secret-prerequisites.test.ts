import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginRegistry, PluginRegistryStore } from "../src/plugin-system/registry-store.js";
import { parsePluginManifest } from "../src/plugin-system/manifest.js";

let root: string;
let pluginsDir: string;
let previousDataDir: string | undefined;

function memoryStore(initial: PluginRegistry = {}) {
  let registry = structuredClone(initial);
  let writeCount = 0;
  let pendingWriteFailure: Error | undefined;
  const store: PluginRegistryStore & { current(): PluginRegistry; writes(): number; failNextWrite(error?: Error): void } = {
    read: () => structuredClone(registry),
    write(next) {
      if (pendingWriteFailure) {
        const error = pendingWriteFailure;
        pendingWriteFailure = undefined;
        throw error;
      }
      registry = structuredClone(next); writeCount += 1;
    },
    current: () => structuredClone(registry),
    writes: () => writeCount,
    failNextWrite(error = new Error("registry save failed")) { pendingWriteFailure = error; },
  };
  return store;
}

function makePlugin(id: string, secretName?: string, marker?: string): string {
  const dir = join(pluginsDir, id);
  mkdirSync(dir, { recursive: true });
  const toolName = `${id.replace(/-/g, "_")}_action`;
  const entry = `${marker ? `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "imported");` : ""}
export const ${toolName} = {
  name: ${JSON.stringify(toolName)},
  description: "secret prerequisite test",
  parameters: { type: "object", properties: {}, required: [] },
  async execute() { return { content: "executed" }; }
};\n`;
  writeFileSync(join(dir, "index.mjs"), entry, "utf-8");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    id,
    name: id,
    version: "1.0.0",
    description: "secret prerequisite test",
    entryPoint: "index.mjs",
    contributions: {
      tools: [toolName],
      ...(secretName ? { secrets: [{ name: secretName, service: "Example", description: "Plugin token" }] } : {}),
    },
  }), "utf-8");
  return dir;
}

interface AvailabilitySource {
  has(name: string): boolean;
  onAvailabilityChange?(listener: (change: { type: "available" | "deleted"; name: string }) => void): () => void;
}

async function freshHarness(
  store: PluginRegistryStore,
  available: Set<string> | AvailabilitySource,
  toolName: string,
) {
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
    rules: [{ id: "allow-secret-plugin", tool: toolName, decision: "allow", reason: "test" }],
  });
  const manager = new PluginManager(store);
  manager.bindToolSurface(new PluginToolSurface(registry, live, policy));
  let notify = (_change: { type: "available" | "deleted"; name: string }) => {};
  if (available instanceof Set) {
    manager.bindSecretAvailability({
      has: (name) => available.has(name),
      onAvailabilityChange(listener) { notify = listener; return () => {}; },
    });
  } else {
    manager.bindSecretAvailability(available);
  }
  return { manager, registry, live, notify: (change: { type: "available" | "deleted"; name: string }) => notify(change) };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "lax-plugin-secret-")));
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

describe("plugin secret prerequisites", () => {
  it("accepts required-only secret declarations and rejects ambiguous names or optional fields", () => {
    const base = {
      id: "manifest-plugin",
      name: "Manifest Plugin",
      version: "1.0.0",
      description: "manifest",
      entryPoint: "index.mjs",
      contributions: { tools: ["manifest_action"], secrets: [{ name: "PLUGIN_TOKEN" }] },
    };
    expect(parsePluginManifest(base).contributions?.secrets).toEqual([{ name: "PLUGIN_TOKEN" }]);
    expect(() => parsePluginManifest({
      ...base,
      contributions: { tools: ["manifest_action"], secrets: [{ name: "plugin-token" }] },
    })).toThrow("must be canonical");
    expect(() => parsePluginManifest({
      ...base,
      contributions: { tools: ["manifest_action"], secrets: [{ name: "PLUGIN_TOKEN", optional: true }] },
    })).toThrow("unknown field");
  });

  it("verifies and records a repairable missing-secret state without import or persistence", async () => {
    const marker = join(root, "imported.txt");
    const dir = makePlugin("needs-token", "PLUGIN_TOKEN", marker);
    const store = memoryStore();
    const { manager, registry, live } = await freshHarness(store, new Set(), "needs_token_action");

    await expect(manager.loadPlugin(dir)).rejects.toThrow("requires secrets: PLUGIN_TOKEN");
    expect(store.writes()).toBe(0);
    expect(store.current()).toEqual({});
    expect(existsSync(marker)).toBe(false);
    expect(registry.get("needs_token_action")).toBeUndefined();
    expect(live).toEqual([]);
    const listed = manager.listPlugins();
    expect(listed).toEqual([expect.objectContaining({
      id: "needs-token",
      status: "needs_secrets",
      missingSecrets: ["PLUGIN_TOKEN"],
      requiredSecrets: [{ name: "PLUGIN_TOKEN", service: "Example", description: "Plugin token" }],
    })]);
    expect(JSON.stringify(listed)).not.toContain("imported.txt");
  });

  it("serializes secret-triggered restore through the normal persisted activation transaction", async () => {
    const dir = makePlugin("restore-token", "PLUGIN_TOKEN");
    const store = memoryStore();
    const available = new Set<string>();
    const { manager, registry, live } = await freshHarness(store, available, "restore_token_action");
    await expect(manager.loadPlugin(dir)).rejects.toThrow("PLUGIN_TOKEN");

    available.add("PLUGIN_TOKEN");
    await Promise.all([manager.onSecretAdded("PLUGIN_TOKEN"), manager.onSecretAdded("PLUGIN_TOKEN")]);

    expect(manager.isLoaded("restore-token")).toBe(true);
    expect(store.writes()).toBe(1);
    expect(live.map((tool) => tool.name)).toEqual(["restore_token_action"]);
    expect(registry.get("restore_token_action")).toBe(live[0]);
  });

  it("does not publish a failed vault write or let manual retry activate the plugin", async () => {
    const dir = makePlugin("atomic-token", "PLUGIN_TOKEN");
    const store = memoryStore();
    const [{ SecretsStore }, { atomicWriteFileSync }] = await Promise.all([
      import("../src/secrets.js"),
      import("../src/util/json-store.js"),
    ]);
    const vault = new SecretsStore(join(root, "vault"), (path, data, opts) => {
      atomicWriteFileSync(path, data, opts, {
        write(temp, content, writeOpts) { writeFileSync(temp, content, writeOpts); },
        rename() { throw new Error("injected rename failure"); },
        unlink: unlinkSync,
      });
    });
    const { manager, registry, live } = await freshHarness(store, vault, "atomic_token_action");
    await expect(manager.loadPlugin(dir)).rejects.toThrow("PLUGIN_TOKEN");
    const changes: unknown[] = [];
    vault.onAvailabilityChange((change) => changes.push(change));
    expect(() => vault.set("PLUGIN_TOKEN", "SECRET_CANARY_atomic")).toThrow("injected rename failure");

    expect(vault.has("PLUGIN_TOKEN")).toBe(false);
    expect(changes).toEqual([]);
    expect(manager.listPlugins()).toEqual([
      expect.objectContaining({ id: "atomic-token", status: "needs_secrets", missingSecrets: ["PLUGIN_TOKEN"] }),
    ]);
    await expect(manager.retryPlugin("atomic-token")).rejects.toThrow("PLUGIN_TOKEN");
    expect(manager.isLoaded("atomic-token")).toBe(false);
    expect(registry.get("atomic_token_action")).toBeUndefined();
    expect(live).toEqual([]);
    expect(store.writes()).toBe(0);
  });

  it("retains first-install identity after activation fails so ID-only retry can recover", async () => {
    const dir = makePlugin("activation-retry", "PLUGIN_TOKEN");
    const store = memoryStore();
    const available = new Set<string>();
    const { manager, registry, live } = await freshHarness(store, available, "activation_retry_action");
    await expect(manager.loadPlugin(dir)).rejects.toThrow("PLUGIN_TOKEN");
    vi.spyOn(registry, "register").mockImplementationOnce(() => { throw new Error("activation failed"); });

    available.add("PLUGIN_TOKEN");
    await manager.onSecretAdded("PLUGIN_TOKEN");

    expect(manager.isLoaded("activation-retry")).toBe(false);
    expect(manager.listPlugins()).toEqual([
      expect.objectContaining({ id: "activation-retry", status: "failed", missingSecrets: [] }),
    ]);
    await expect(manager.retryPlugin("activation-retry")).resolves.toEqual(
      expect.objectContaining({ id: "activation-retry" }),
    );
    expect(manager.isLoaded("activation-retry")).toBe(true);
    expect(live.map((tool) => tool.name)).toEqual(["activation_retry_action"]);
  });

  it("revokes dependent tools synchronously after deletion and restores after replacement", async () => {
    const dir = makePlugin("rotate-token", "PLUGIN_TOKEN");
    const store = memoryStore();
    const available = new Set(["PLUGIN_TOKEN"]);
    const { manager, registry, live, notify } = await freshHarness(store, available, "rotate_token_action");
    await manager.loadPlugin(dir);
    const stale = live[0];

    available.delete("PLUGIN_TOKEN");
    notify({ type: "deleted", name: "PLUGIN_TOKEN" });
    expect(manager.isLoaded("rotate-token")).toBe(false);
    expect(registry.get("rotate_token_action")).toBeUndefined();
    expect(live).toEqual([]);
    expect(manager.listPlugins()).toEqual([expect.objectContaining({ status: "needs_secrets" })]);
    expect(await stale.execute({})).toEqual(expect.objectContaining({ status: "blocked", isError: true }));

    available.add("PLUGIN_TOKEN");
    notify({ type: "available", name: "PLUGIN_TOKEN" });
    await manager.retryPlugin("rotate-token");
    expect(manager.isLoaded("rotate-token")).toBe(true);
    expect(live.map((tool) => tool.name)).toEqual(["rotate_token_action"]);
  });

  it("fails closed and stays repair-visible when tool-surface cleanup throws", async () => {
    const dir = makePlugin("cleanup-token", "PLUGIN_TOKEN");
    const store = memoryStore();
    const available = new Set(["PLUGIN_TOKEN"]);
    const { manager, registry, live, notify } = await freshHarness(store, available, "cleanup_token_action");
    await manager.loadPlugin(dir);
    const stale = live[0];
    vi.spyOn(registry, "unregister").mockImplementation(() => { throw new Error("cleanup failed"); });

    available.delete("PLUGIN_TOKEN");
    expect(() => notify({ type: "deleted", name: "PLUGIN_TOKEN" })).not.toThrow();

    expect(manager.isLoaded("cleanup-token")).toBe(false);
    expect(registry.get("cleanup_token_action")).toBeUndefined();
    expect(await stale.execute({})).toEqual(expect.objectContaining({ status: "blocked", isError: true }));
    expect(manager.listPlugins()).toEqual([
      expect.objectContaining({ status: "needs_secrets", error: "Plugin tool revocation cleanup failed" }),
    ]);

    available.add("PLUGIN_TOKEN");
    notify({ type: "available", name: "PLUGIN_TOKEN" });
    await expect(manager.retryPlugin("cleanup-token")).resolves.toEqual(expect.objectContaining({ id: "cleanup-token" }));
    expect(registry.get("cleanup_token_action")).toBeDefined();
  });

  it("rediscovers an unpersisted missing-secret install after restart without executing it", async () => {
    const marker = join(root, "restart-imported.txt");
    const dir = makePlugin("restart-token", "PLUGIN_TOKEN", marker);
    const store = memoryStore();
    const first = await freshHarness(store, new Set(), "restart_token_action");
    await expect(first.manager.loadPlugin(dir)).rejects.toThrow("PLUGIN_TOKEN");

    const restarted = await freshHarness(store, new Set(), "restart_token_action");
    await restarted.manager.discoverSecretRequirements();

    expect(store.current()).toEqual({});
    expect(existsSync(marker)).toBe(false);
    expect(restarted.manager.listPlugins()).toEqual([
      expect.objectContaining({ id: "restart-token", status: "needs_secrets", missingSecrets: ["PLUGIN_TOKEN"] }),
    ]);
  });

  it("retains a verified ready candidate across the missing-secret crash window", async () => {
    const marker = join(root, "ready-imported.txt");
    const dir = makePlugin("ready-token", "PLUGIN_TOKEN", marker);
    const store = memoryStore();
    const first = await freshHarness(store, new Set<string>(), "ready_token_action");
    await expect(first.manager.loadPlugin(dir)).rejects.toThrow("PLUGIN_TOKEN");

    const { SecretsStore } = await import("../src/secrets.js");
    const durableVault = new SecretsStore(join(root, "durable-vault"));
    durableVault.set("PLUGIN_TOKEN", "durable-secret-value");
    const restarted = await freshHarness(store, durableVault, "ready_token_action");
    await restarted.manager.discoverSecretRequirements();

    expect(store.current()).toEqual({});
    expect(store.writes()).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(restarted.registry.get("ready_token_action")).toBeUndefined();
    expect(restarted.manager.listPlugins()).toEqual([
      expect.objectContaining({ id: "ready-token", status: "ready", missingSecrets: [] }),
    ]);

    await expect(restarted.manager.retryPlugin("ready-token")).resolves.toEqual(
      expect.objectContaining({ id: "ready-token" }),
    );
    expect(restarted.manager.isLoaded("ready-token")).toBe(true);
    expect(store.writes()).toBe(1);
  });

  it("rediscovers a ready candidate after first-install persistence failed before activation", async () => {
    const marker = join(root, "persist-imported.txt");
    const dir = makePlugin("persist-token", "PLUGIN_TOKEN", marker);
    const store = memoryStore();
    const available = new Set(["PLUGIN_TOKEN"]);
    store.failNextWrite();
    const first = await freshHarness(store, available, "persist_token_action");
    await expect(first.manager.loadPlugin(dir)).rejects.toThrow("Plugin load could not be persisted");
    expect(first.manager.isLoaded("persist-token")).toBe(false);
    expect(store.current()).toEqual({});

    rmSync(marker, { force: true });
    const restarted = await freshHarness(store, available, "persist_token_action");
    await restarted.manager.discoverSecretRequirements();

    expect(existsSync(marker)).toBe(false);
    expect(restarted.manager.listPlugins()).toEqual([
      expect.objectContaining({ id: "persist-token", status: "ready", missingSecrets: [] }),
    ]);
    await expect(restarted.manager.retryPlugin("persist-token")).resolves.toEqual(
      expect.objectContaining({ id: "persist-token" }),
    );
    expect(restarted.manager.isLoaded("persist-token")).toBe(true);
    expect(store.writes()).toBe(1);
  });

  it("does not turn a disabled registered plugin into a needs-secrets repair task", async () => {
    const dir = makePlugin("disabled-token", "PLUGIN_TOKEN");
    const entryPath = join(dir, "index.mjs");
    const manifestPath = join(dir, "manifest.json");
    const store = memoryStore({
      "disabled-token": {
        enabled: false,
        path: dir,
        entryHash: createHash("sha256").update(readFileSync(entryPath)).digest("hex"),
        manifestHash: createHash("sha256").update(readFileSync(manifestPath)).digest("hex"),
      },
    });
    const { manager } = await freshHarness(store, new Set(), "disabled_token_action");

    await manager.discoverSecretRequirements();

    expect(manager.listPlugins()).toEqual([
      expect.objectContaining({ id: "disabled-token", enabled: false, status: "disabled" }),
    ]);
  });

  it("rejects tampering before reporting missing secrets", async () => {
    const original = "export const intact = true;\n";
    const dir = makePlugin("tampered-token", "PLUGIN_TOKEN");
    const entryPath = join(dir, "index.mjs");
    const manifest = readFileSync(join(dir, "manifest.json"), "utf-8");
    const store = memoryStore({
      "tampered-token": {
        enabled: true,
        path: dir,
        entryHash: createHash("sha256").update(readFileSync(entryPath)).digest("hex"),
        manifestHash: createHash("sha256").update(manifest).digest("hex"),
      },
    });
    writeFileSync(entryPath, original, "utf-8");
    const { manager } = await freshHarness(store, new Set(), "tampered_token_action");

    await expect(manager.loadAllEnabled()).resolves.toEqual([]);
    expect(manager.listPlugins()).toEqual([
      expect.objectContaining({ id: "tampered-token", status: "failed", error: "Integrity verification failed" }),
    ]);
  });

  it("does not change the load path for plugins with no declared secrets", async () => {
    const dir = makePlugin("plain-plugin");
    const store = memoryStore();
    const { manager, live } = await freshHarness(store, new Set(), "plain_plugin_action");

    await expect(manager.loadPlugin(dir)).resolves.toEqual(expect.objectContaining({ id: "plain-plugin" }));
    expect(manager.isLoaded("plain-plugin")).toBe(true);
    expect(live.map((tool) => tool.name)).toEqual(["plain_plugin_action"]);
  });
});
