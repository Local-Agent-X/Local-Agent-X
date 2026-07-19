import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPluginList } from "../src/plugin-system/list-items.js";
import { pluginManifestMetadata, type PluginManifest } from "../src/plugin-system/manifest.js";
import { createPluginRegistryStore, type PluginRegistry } from "../src/plugin-system/registry-store.js";
import type { SecretBlockedPlugin } from "../src/plugin-system/secret-requirements.js";
import { PluginToolSurface } from "../src/plugin-system/tool-surface.js";
import { ToolPolicy } from "../src/tool-policy/index.js";
import { UnifiedToolRegistry } from "../src/tools/registry.js";
import { createToolSearchTool } from "../src/tools/tool-search.js";
import type { ToolDefinition } from "../src/types.js";

const dirs: string[] = [];
const surfaces: Array<{ surface: PluginToolSurface; id: string }> = [];

const manifest: PluginManifest = {
  id: "weather-plugin",
  name: "Weather Plugin",
  version: "2.1.0",
  description: "Weather tools",
  entryPoint: "private/index.mjs",
  tools: ["weather_lookup"],
  contributions: {
    tools: ["weather_lookup"],
    secrets: [{ name: "WEATHER_TOKEN", service: "Weather" }],
  },
  publisher: "example.publisher",
  signature: "deadbeef",
};

function registry(enabled = true): PluginRegistry {
  return {
    [manifest.id]: {
      enabled,
      path: "C:\\private\\plugins\\weather-plugin",
      entryHash: "a".repeat(64),
      manifestHash: "b".repeat(64),
      manifest: pluginManifestMetadata(manifest),
    },
  };
}

function activeSurface() {
  const toolRegistry = new UnifiedToolRegistry();
  const live: ToolDefinition[] = [];
  const policy = new ToolPolicy({
    defaultDecision: "deny",
    rules: [{ id: "weather", tool: "weather_lookup", decision: "allow", reason: "test" }],
  });
  const surface = new PluginToolSurface(toolRegistry, live, policy);
  const tool: ToolDefinition = {
    name: "weather_lookup",
    description: "Look up weather",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() { return { content: "sunny" }; },
  };
  const prepared = surface.prepare(manifest.id, manifest, { weather_lookup: tool }, "c".repeat(64))!;
  surfaces.push({ surface, id: manifest.id });
  return { surface, prepared, toolRegistry };
}

afterEach(() => {
  for (const { surface, id } of surfaces.splice(0)) surface.deactivate(id);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("canonical plugin metadata projection", () => {
  it("round-trips durable identity metadata and rejects registry aliases", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-plugin-metadata-"));
    dirs.push(dir);
    const path = join(dir, "registry.json");
    const store = createPluginRegistryStore(path);
    store.write(registry());

    expect(store.read()[manifest.id].manifest).toEqual(pluginManifestMetadata(manifest));

    writeFileSync(path, JSON.stringify({
      alias: { ...registry()[manifest.id], manifest: pluginManifestMetadata(manifest) },
    }), "utf-8");
    expect(() => store.read()).toThrow("Plugin registry is invalid");
  });

  it("projects only a fully committed active surface and matches tool_search", async () => {
    const { surface, prepared, toolRegistry } = activeSurface();
    const loaded = new Map([[manifest.id, {
      manifest,
      trustLevel: "signed" as const,
      manifestHash: "b".repeat(64),
    }]]);

    const before = buildPluginList(registry(), loaded, new Map(), new Map(), (id) => surface.listActive(id))[0];
    expect(before.activeTools).toEqual([]);

    surface.activate(prepared);
    const item = buildPluginList(registry(), loaded, new Map(), new Map(), (id) => surface.listActive(id))[0];
    const searched = JSON.parse((await createToolSearchTool(toolRegistry).execute({ query: "weather_lookup" })).content);

    expect(item).toMatchObject({
      registryId: manifest.id,
      id: manifest.id,
      version: "2.1.0",
      publisher: "example.publisher",
      manifestHash: "b".repeat(64),
      status: "loaded",
      declaredTools: ["weather_lookup"],
      secretsReady: true,
    });
    expect(item.activeTools.map((tool) => ({ name: tool.name, description: tool.description }))).toEqual(
      searched.map((tool: { name: string; description: string }) => ({ name: tool.name, description: tool.description })),
    );
    expect(item.activeTools[0].implementationFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(item)).not.toContain("private");
    expect(JSON.stringify(item)).not.toContain("deadbeef");
    expect(JSON.stringify(item.activeTools)).not.toContain("parameters");
  });

  it("keeps prepared and failed entries visible with zero executable metadata", () => {
    const { surface, prepared } = activeSurface();
    const errors = new Map([[manifest.id, { error: "Plugin tool surface is invalid", manifest, manifestHash: "b".repeat(64) }]]);
    const item = buildPluginList(registry(), new Map(), errors, new Map(), (id) => surface.listActive(id))[0];

    expect(item).toMatchObject({
      status: "failed",
      enabled: true,
      declaredTools: ["weather_lookup"],
      activeTools: [],
      error: "Plugin tool surface is invalid",
    });
    surface.abort(prepared);
  });

  it("keeps disabled restart metadata without making declarations executable", () => {
    const item = buildPluginList(registry(false), new Map(), new Map(), new Map())[0];
    expect(item).toMatchObject({
      status: "disabled",
      enabled: false,
      name: "Weather Plugin",
      version: "2.1.0",
      declaredTools: ["weather_lookup"],
      activeTools: [],
    });
  });

  it("projects secret readiness from lifecycle facts without secret values or paths", () => {
    const blocked = new Map<string, SecretBlockedPlugin>([[manifest.id, {
      manifest,
      path: "C:\\private\\plugins\\weather-plugin",
      trustLevel: "signed",
      missingSecrets: ["WEATHER_TOKEN"],
      manifestHash: "b".repeat(64),
    }]]);
    const item = buildPluginList(registry(), new Map(), new Map(), blocked)[0];
    const serialized = JSON.stringify(item);

    expect(item).toMatchObject({
      status: "needs_secrets",
      requiredSecrets: [{ name: "WEATHER_TOKEN", service: "Weather" }],
      missingSecrets: ["WEATHER_TOKEN"],
      secretsReady: false,
      activeTools: [],
    });
    expect(serialized).not.toContain("C:\\\\private");
    expect(serialized).not.toContain("signature");
    expect(serialized).not.toContain("entryPoint");
  });

  it("contains one malformed registry without blocking a sanitized core status", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-plugin-corrupt-"));
    dirs.push(dir);
    const path = join(dir, "registry.json");
    writeFileSync(path, JSON.stringify({
      broken: {
        enabled: true,
        path: "C:\\private\\plugin",
        manifest: { ...pluginManifestMetadata(manifest), requiredSecrets: "SECRET_CANARY" },
      },
    }), "utf-8");
    const store = createPluginRegistryStore(path);

    expect(() => store.read()).toThrow("Plugin registry is invalid");
    const fallback = buildPluginList({}, new Map(), new Map([[
      "plugin-registry", { error: "Plugin registry is invalid" },
    ]]), new Map())[0];
    expect(fallback).toMatchObject({ id: "plugin-registry", status: "failed", activeTools: [] });
    expect(JSON.stringify(fallback)).not.toContain("private");
    expect(JSON.stringify(fallback)).not.toContain("SECRET_CANARY");
  });
});
