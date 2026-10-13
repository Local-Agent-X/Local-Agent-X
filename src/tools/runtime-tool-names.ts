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
import type { ToolPluginContext } from "./plugin.js";
import { allTools } from "./registry-build.js";
import { plugins } from "./plugins.js";
import { unifiedRegistry } from "./registry.js";
import { builderToolsForTier } from "./build-app-runtime.js";
import { createArikernelBridgeTools } from "./arikernel-bridge.js";

export async function collectRuntimeToolNames(): Promise<Set<string>> {
  const dataDir = mkdtempSync(join(tmpdir(), "lax-tool-catalog-"));
  const ctx = {
    secretsStore: {},
    memoryIndex: {},
    cronService: {},
    dataDir,
    activeOnEventBySession: new Map(),
    activeBrowserSessionIdRef: { value: "" },
    activeRuntimeBySession: new Map(),
    registry: unifiedRegistry,
  } as unknown as ToolPluginContext;
  const names = new Set(allTools.map((t) => t.name));
  try {
    for (const plugin of plugins) {
      for (const tool of await plugin.register(ctx)) names.add(tool.name);
    }
    for (const tool of builderToolsForTier("full-stack")) names.add(tool.name);
    for (const tool of createArikernelBridgeTools({ sqliteDatabase: {} as never })) names.add(tool.name);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
  return names;
}
