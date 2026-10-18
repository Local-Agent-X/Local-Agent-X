// The set of tool names the runtime can actually dispatch, built the way boot
// builds it: `allTools` plus every plugin's tools plus the app-build tier and
// the arikernel bridge. Coverage tests use this instead of `allTools` because
// most tools register through plugins (`setting`, `http_request`, memory,
// browser, agents, …) — a check over `allTools` alone never saw them, which is
// how a plugin tool could ship without a policy entry and hit default-deny
// in production.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "../types.js";
import type { ToolPluginContext } from "./plugin.js";
import { allTools } from "./registry-build.js";
import { plugins } from "./plugins.js";
import { unifiedRegistry } from "./registry.js";
import { builderToolsForTier } from "./build-app-runtime.js";
import { createArikernelBridgeTools } from "./arikernel-bridge.js";

/** Every tool definition the runtime can dispatch, first registration wins. */
export async function collectRuntimeTools(): Promise<Map<string, ToolDefinition>> {
  const dataDir = mkdtempSync(join(tmpdir(), "lax-tool-catalog-"));
  const ctx = {
    secretsStore: {},
    memoryIndex: {},
    cronService: {},
    dataDir,
    activeBrowserSessionIdRef: { value: "" },
    activeRuntimeBySession: new Map(),
    registry: unifiedRegistry,
  } as unknown as ToolPluginContext;
  const tools = new Map<string, ToolDefinition>();
  const add = (tool: ToolDefinition) => { if (!tools.has(tool.name)) tools.set(tool.name, tool); };
  allTools.forEach(add);
  try {
    for (const plugin of plugins) (await plugin.register(ctx)).forEach(add);
    builderToolsForTier("full-stack").forEach(add);
    createArikernelBridgeTools({ sqliteDatabase: {} as never }).forEach(add);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
  return tools;
}

export async function collectRuntimeToolNames(): Promise<Set<string>> {
  return new Set((await collectRuntimeTools()).keys());
}
