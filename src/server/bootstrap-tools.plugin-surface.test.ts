import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../types.js";

const fixtures = vi.hoisted(() => {
  const builtin: ToolDefinition = {
    name: "builtin_tool",
    description: "built in",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() { return { content: "builtin" }; },
  };
  const external: ToolDefinition = {
    name: "boot_plugin_action",
    description: "external plugin action",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() { return { content: "plugin" }; },
  };
  return { builtin, external, surface: undefined as import("../plugin-system/tool-surface.js").PluginToolSurfacePort | undefined };
});

vi.mock("../tools.js", () => ({ allTools: [] }));
vi.mock("../tools/plugins.js", () => ({
  BRIDGE_PLUGIN_IDS: new Set<string>(),
  plugins: [{ id: "core", register: () => [fixtures.builtin] }],
}));
vi.mock("../plugin-system.js", () => ({
  pluginManager: {
    bindToolSurface(surface: import("../plugin-system/tool-surface.js").PluginToolSurfacePort) {
      fixtures.surface = surface;
    },
    async loadAllEnabled() {
      expect(fixtures.surface).toBeDefined();
      const manifest = {
        id: "boot-plugin",
        name: "boot-plugin",
        version: "1.0.0",
        description: "boot test",
        entryPoint: "index.mjs",
        tools: ["boot_plugin_action"],
        contributions: { tools: ["boot_plugin_action"] },
      };
      const prepared = fixtures.surface!.prepare("boot-plugin", manifest, {
        boot_plugin_action: fixtures.external,
      });
      fixtures.surface!.activate(prepared!);
      return [manifest];
    },
  },
}));
vi.mock("../mcp-client/index.js", () => ({
  MCPManager: {
    getInstance: () => ({
      connectAll: async () => undefined,
      startConfigWatcher: () => undefined,
      getAllTools: () => [],
      setOnToolsChanged: () => undefined,
      disconnectAll: () => undefined,
    }),
  },
}));

import { ToolPolicy } from "../tool-policy/index.js";
import { unifiedRegistry } from "../tools/registry.js";
import { bootstrapTools } from "./bootstrap-tools.js";

beforeEach(() => {
  unifiedRegistry._resetForTesting();
  fixtures.surface = undefined;
});

afterEach(() => {
  fixtures.surface?.deactivate("boot-plugin");
  unifiedRegistry._resetForTesting();
});

describe("bootstrapTools declarative plugin projection", () => {
  it("restores after built-ins and returns one live canonical tool surface", async () => {
    const toolPolicy = new ToolPolicy({
      defaultDecision: "deny",
      rules: [{
        id: "allow-boot-plugin-action",
        tool: "boot_plugin_action",
        decision: "allow",
        reason: "test",
      }],
    });
    const bundle = await bootstrapTools({
      secretsStore: {} as never,
      cronService: {} as never,
      memoryIndex: {} as never,
      dataDir: "C:\\test",
      toolPolicy,
    });

    expect(bundle.allAgentTools.map((tool) => tool.name)).toEqual(["builtin_tool", "boot_plugin_action"]);
    expect(bundle.toolRegistry.get("boot_plugin_action")).toBe(bundle.allAgentTools[1]);
    expect(bundle.toolRegistry.getDeferredTools().map((tool) => tool.name)).toContain("boot_plugin_action");
  });
});

