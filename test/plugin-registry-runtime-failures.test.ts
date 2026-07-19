import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginRegistryStore } from "../src/plugin-system/registry-store.js";
import { PluginToolSurface } from "../src/plugin-system/tool-surface.js";
import { ToolPolicy } from "../src/tool-policy/index.js";
import { UnifiedToolRegistry } from "../src/tools/registry.js";
import { createToolSearchTool } from "../src/tools/tool-search.js";
import type { ToolDefinition } from "../src/types.js";

const roots: string[] = [];

async function harness(readCommitted?: (path: string, encoding: "utf-8") => string, secretName?: string) {
  const root = mkdtempSync(join(tmpdir(), "lax-plugin-registry-runtime-"));
  roots.push(root);
  const pluginDir = join(root, "plugins", "runtime-registry");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "index.mjs"), `export const registry_probe = {
  name: "registry_probe", description: "registry probe",
  parameters: { type: "object", properties: {}, required: [] },
  async execute() { return { content: "executed" }; }
};\n`, "utf-8");
  writeFileSync(join(pluginDir, "manifest.json"), JSON.stringify({
    id: "runtime-registry", name: "Runtime Registry", version: "1.0.0",
    description: "registry lifecycle test", entryPoint: "index.mjs",
    contributions: {
      tools: ["registry_probe"],
      ...(secretName ? { secrets: [{ name: secretName, service: "Registry Test" }] } : {}),
    },
  }), "utf-8");
  const registryPath = join(root, "plugins", "registry.json");
  const store = createPluginRegistryStore(registryPath, undefined, readCommitted);
  const previous = process.env.LAX_DATA_DIR;
  process.env.LAX_DATA_DIR = root;
  vi.resetModules();
  const { PluginManager } = await import("../src/plugin-system.js");
  if (previous === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = previous;
  const toolRegistry = new UnifiedToolRegistry();
  const live: ToolDefinition[] = [];
  const surface = new PluginToolSurface(toolRegistry, live, new ToolPolicy({
    defaultDecision: "deny",
    rules: [{ id: "registry-probe", tool: "registry_probe", decision: "allow", reason: "test" }],
  }));
  const manager = new PluginManager(store);
  manager.bindToolSurface(surface);
  return { manager, store, registryPath, pluginDir, toolRegistry, live, surface };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime plugin registry failure classification", () => {
  it.each(["EAGAIN", "EBUSY", "EACCES"])("preserves active autonomy across one-shot %s reads", async (code) => {
    let fail: string | undefined;
    const h = await harness((path, encoding) => {
      if (!fail) return readFileSync(path, encoding);
      const current = fail; fail = undefined;
      throw Object.assign(new Error(`private ${current} path`), { code: current });
    });
    await h.manager.loadPlugin(h.pluginDir);
    const stale = h.toolRegistry.get("registry_probe")!;
    fail = code;
    const listed = h.manager.listPlugins();
    expect(listed).toEqual([
      expect.objectContaining({ id: "plugin-registry", error: "Plugin registry is temporarily unavailable" }),
      expect.objectContaining({ id: "runtime-registry", status: "loaded", activeTools: [expect.objectContaining({ name: "registry_probe" })] }),
    ]);
    expect(JSON.stringify(listed)).not.toContain("private");
    expect(h.manager.isLoaded("runtime-registry")).toBe(true);
    expect(h.live).toEqual([stale]);
    expect(await stale.execute({})).toEqual({ content: "executed" });
    expect(JSON.parse((await createToolSearchTool(h.toolRegistry).execute({ query: "registry_probe" })).content)).toHaveLength(1);

    fail = code;
    expect(() => h.manager.disablePlugin("runtime-registry")).toThrow("temporarily unavailable");
    expect(h.manager.isLoaded("runtime-registry")).toBe(true);
    expect(h.toolRegistry.get("registry_probe")).toBe(stale);
    expect(await stale.execute({})).toEqual({ content: "executed" });
    expect(h.manager.listPlugins()).toEqual([expect.objectContaining({ id: "runtime-registry", status: "loaded" })]);
    h.surface.deactivate("runtime-registry");
  });

  it("treats a one-shot truncated read followed by valid bytes as unavailable, not corrupt", async () => {
    let truncate = false;
    const h = await harness((path, encoding) => {
      const committed = readFileSync(path, encoding);
      if (!truncate) return committed;
      truncate = false;
      return committed.slice(0, Math.max(1, Math.floor(committed.length / 2)));
    });
    await h.manager.loadPlugin(h.pluginDir);
    const active = h.toolRegistry.get("registry_probe")!;
    truncate = true;
    expect(h.manager.listPlugins()).toEqual([
      expect.objectContaining({ id: "plugin-registry", error: "Plugin registry is temporarily unavailable" }),
      expect.objectContaining({ id: "runtime-registry", status: "loaded" }),
    ]);
    expect(h.manager.isLoaded("runtime-registry")).toBe(true);
    expect(h.toolRegistry.get("registry_probe")).toBe(active);
    expect(await active.execute({})).toEqual({ content: "executed" });
    expect(h.manager.listPlugins()).toEqual([expect.objectContaining({ id: "runtime-registry", status: "loaded" })]);
    h.surface.deactivate("runtime-registry");
  });

  it("treats invalid bytes that change during confirmation as unavailable", async () => {
    let changeOnConfirmation = false;
    let reads = 0;
    const h = await harness((path, encoding) => {
      reads += 1;
      if (changeOnConfirmation && reads % 2 === 0) writeFileSync(path, '{"changed-invalid":', "utf-8");
      return readFileSync(path, encoding);
    });
    await h.manager.loadPlugin(h.pluginDir);
    const durable = h.store.read();
    const active = h.toolRegistry.get("registry_probe")!;
    writeFileSync(h.registryPath, '{"first-invalid":', "utf-8");
    reads = 0; changeOnConfirmation = true;
    expect(h.manager.listPlugins()).toEqual([
      expect.objectContaining({ id: "plugin-registry", error: "Plugin registry is temporarily unavailable" }),
      expect.objectContaining({ id: "runtime-registry", status: "loaded" }),
    ]);
    expect(h.manager.isLoaded("runtime-registry")).toBe(true);
    expect(h.toolRegistry.get("registry_probe")).toBe(active);
    expect(await active.execute({})).toEqual({ content: "executed" });
    changeOnConfirmation = false;
    h.store.write(durable);
    expect(h.manager.listPlugins()).toEqual([expect.objectContaining({ id: "runtime-registry", status: "loaded" })]);
    h.surface.deactivate("runtime-registry");
  });

  it.each([
    ["json", '{"private-canary":'],
    ["schema", JSON.stringify({ "runtime-registry": { enabled: "yes", path: "C:\\private" } })],
    ["integrity", JSON.stringify({ "runtime-registry": {
      enabled: true, path: "C:\\private", entryHash: "not-a-sha256",
    } })],
  ])("revokes every surface for confirmed %s corruption and recovers", async (_kind, corrupt) => {
    const h = await harness();
    await h.manager.loadPlugin(h.pluginDir);
    const durable = h.store.read();
    const stale = h.toolRegistry.get("registry_probe")!;
    writeFileSync(h.registryPath, corrupt, "utf-8");

    const failed = h.manager.listPlugins();
    expect(failed).toEqual([expect.objectContaining({
      id: "plugin-registry", error: "Plugin registry is invalid", activeTools: [],
    })]);
    expect(JSON.stringify(failed)).not.toContain("private");
    expect(h.manager.isLoaded("runtime-registry")).toBe(false);
    expect(h.toolRegistry.get("registry_probe")).toBeUndefined();
    expect(h.live).toEqual([]);
    expect(await stale.execute({})).toEqual(expect.objectContaining({ status: "blocked", isError: true }));

    h.store.write(durable);
    await expect(h.manager.loadAllEnabled()).resolves.toEqual([expect.objectContaining({ id: "runtime-registry" })]);
    expect(h.manager.listPlugins()).toEqual([expect.objectContaining({
      id: "runtime-registry", status: "loaded", activeTools: [expect.objectContaining({ name: "registry_probe" })],
    })]);
    expect(await h.toolRegistry.get("registry_probe")!.execute({})).toEqual({ content: "executed" });
    h.surface.deactivate("runtime-registry");
  });

  it("keeps needs-secrets state intact when an unbranded private read error interrupts retry", async () => {
    let fail = false;
    const available = new Set<string>();
    const h = await harness((path, encoding) => {
      if (!fail) return readFileSync(path, encoding);
      fail = false;
      throw Object.assign(new Error("EAGAIN at C:\\private\\registry.json"), { code: "EAGAIN" });
    }, "PLUGIN_TOKEN");
    h.store.write({});
    h.manager.bindSecretAvailability({ has: (name) => available.has(name) });
    await expect(h.manager.loadPlugin(h.pluginDir)).rejects.toThrow("PLUGIN_TOKEN");
    expect(h.manager.listPlugins()).toEqual([expect.objectContaining({
      id: "runtime-registry", status: "needs_secrets", missingSecrets: ["PLUGIN_TOKEN"],
    })]);

    fail = true;
    await expect(h.manager.retryPlugin("runtime-registry")).rejects.toThrow("Plugin registry read is temporarily unavailable");
    const blocked = h.manager.listPlugins();
    expect(blocked).toEqual([expect.objectContaining({
      id: "runtime-registry", status: "needs_secrets", missingSecrets: ["PLUGIN_TOKEN"],
    })]);
    expect(JSON.stringify(blocked)).not.toContain("private");
    expect(h.toolRegistry.get("registry_probe")).toBeUndefined();

    available.add("PLUGIN_TOKEN");
    await expect(h.manager.retryPlugin("runtime-registry")).resolves.toEqual(expect.objectContaining({ id: "runtime-registry" }));
    expect(h.manager.listPlugins()).toEqual([expect.objectContaining({
      id: "runtime-registry", status: "loaded", missingSecrets: [],
    })]);
    expect(await h.toolRegistry.get("registry_probe")!.execute({})).toEqual({ content: "executed" });
    h.surface.deactivate("runtime-registry");
  });
});
