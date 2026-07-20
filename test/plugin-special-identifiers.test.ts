import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginRegistryStore } from "../src/plugin-system/registry-store.js";
import { PluginToolSurface } from "../src/plugin-system/tool-surface.js";
import { ToolPolicy } from "../src/tool-policy/index.js";
import { UnifiedToolRegistry } from "../src/tools/registry.js";
import { createToolSearchTool } from "../src/tools/tool-search.js";
import type { ToolDefinition } from "../src/types.js";

const SPECIAL_IDS = [
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "＿＿ｐｒｏｔｏ＿＿",
  "ｃｏｎｓｔｒｕｃｔｏｒ",
  "ｐｒｏｔｏｔｙｐｅ",
];
const roots: string[] = [];

function surface() {
  const registry = new UnifiedToolRegistry();
  const live: ToolDefinition[] = [];
  const tools = new PluginToolSurface(registry, live, new ToolPolicy({
    defaultDecision: "deny",
    rules: [{ id: "special-id-probe", tool: "special_id_probe", decision: "allow", reason: "test" }],
  }));
  return { registry, live, tools };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("plugin special identifier lifecycle", () => {
  it.each(SPECIAL_IDS)("preserves %s through persistence, restart, recovery, and actions", async (id) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lax-plugin-special-id-")));
    roots.push(root);
    const pluginDir = join(root, "plugins", id);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "index.mjs"), `export const special_id_probe = {
  name: "special_id_probe", description: "special identifier probe",
  parameters: { type: "object", properties: {}, required: [] },
  async execute() { return { content: "executed" }; }
};\n`, "utf-8");
    writeFileSync(join(pluginDir, "manifest.json"), JSON.stringify({
      id, name: id, version: "1.0.0", description: "special identifier test", entryPoint: "index.mjs",
      contributions: { tools: ["special_id_probe"] },
    }), "utf-8");
    const registryPath = join(root, "plugins", "registry.json");
    let failRead = false;
    const store = createPluginRegistryStore(registryPath, undefined, (path, encoding) => {
      if (failRead) {
        failRead = false;
        throw Object.assign(new Error("EPERM at C:\\private\\registry.json"), { code: "EPERM" });
      }
      return readFileSync(path, encoding);
    });
    const previous = process.env.LAX_DATA_DIR;
    process.env.LAX_DATA_DIR = root;
    vi.resetModules();
    const { PluginManager } = await import("../src/plugin-system.js");
    if (previous === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = previous;

    const firstSurface = surface();
    const first = new PluginManager(store);
    first.bindToolSurface(firstSurface.tools);
    await expect(first.loadPlugin(pluginDir)).resolves.toEqual(expect.objectContaining({ id }));
    const saved = readFileSync(registryPath, "utf-8");
    expect(Object.hasOwn(JSON.parse(saved), id)).toBe(true);
    const roundTrip = store.read();
    expect(Object.getPrototypeOf(roundTrip)).toBeNull();
    expect(Object.hasOwn(roundTrip, id)).toBe(true);
    expect(roundTrip[id]).toEqual(expect.objectContaining({ enabled: true, path: pluginDir }));
    firstSurface.tools.deactivate(id);

    const restartedSurface = surface();
    const restarted = new PluginManager(store);
    restarted.bindToolSurface(restartedSurface.tools);
    await expect(restarted.loadAllEnabled()).resolves.toEqual([expect.objectContaining({ id })]);
    const stale = restartedSurface.registry.get("special_id_probe")!;
    expect(await stale.execute({})).toEqual({ content: "executed" });
    expect(JSON.parse((await createToolSearchTool(restartedSurface.registry).execute({ query: "special_id_probe" })).content))
      .toEqual([expect.objectContaining({ name: "special_id_probe" })]);

    failRead = true;
    const unavailable = restarted.listPlugins();
    expect(unavailable).toEqual([
      expect.objectContaining({ id: "plugin-registry", error: "Plugin registry is temporarily unavailable" }),
      expect.objectContaining({ id, status: "loaded" }),
    ]);
    expect(JSON.stringify(unavailable)).not.toContain("private");
    expect(await stale.execute({})).toEqual({ content: "executed" });

    writeFileSync(registryPath, "{broken", "utf-8");
    expect(restarted.listPlugins()).toEqual([
      expect.objectContaining({ id: "plugin-registry", error: "Plugin registry is invalid" }),
    ]);
    expect(await stale.execute({})).toEqual(expect.objectContaining({ status: "blocked", isError: true }));
    writeFileSync(registryPath, saved, "utf-8");
    await expect(restarted.loadAllEnabled()).resolves.toEqual([expect.objectContaining({ id })]);

    expect(restarted.listPlugins()).toEqual([expect.objectContaining({
      id, registryId: id, status: "loaded", actions: expect.objectContaining({ disable: true }),
    })]);
    expect(restarted.disablePlugin(id)).toBe(true);
    expect(restarted.listPlugins()).toEqual([expect.objectContaining({
      id, registryId: id, status: "disabled", actions: expect.objectContaining({ enable: true }),
    })]);
    await expect(restarted.enablePlugin(id)).resolves.toEqual(expect.objectContaining({ id }));
    expect(JSON.parse((await createToolSearchTool(restartedSurface.registry).execute({ query: "special_id_probe" })).content))
      .toEqual([expect.objectContaining({ name: "special_id_probe" })]);
    restartedSurface.tools.deactivate(id);
  });
});
