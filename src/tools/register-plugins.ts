// The one walk over the built-in plugins (plugins.ts). Boot
// (server/bootstrap-tools.ts) and the catalog the coverage tests check
// (runtime-tool-names.ts) both make it, so a tool boot would register is a
// tool the tests see, with the audiences boot gives it.
import type { ToolDefinition } from "../types.js";
import type { ToolPlugin, ToolPluginContext } from "./plugin.js";
import { plugins } from "./plugins.js";
import { applyAudiences } from "./audience-map.js";

/** One plugin's tools as boot takes them. */
export interface RegisteredPlugin {
  plugin: ToolPlugin;
  /** Everything the plugin produced, audiences stamped. */
  produced: ToolDefinition[];
  /** `produced` without the names an earlier plugin already defined: the
   *  first definition of a name is the tool. */
  kept: ToolDefinition[];
  /** The names left out of `kept`. */
  duplicates: string[];
}

/**
 * Registers every built-in plugin, in order, and yields each one's tools
 * before the next plugin runs (a plugin may read the registry the earlier ones
 * filled).
 */
export async function* registerPlugins(ctx: ToolPluginContext): AsyncGenerator<RegisteredPlugin> {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    const produced = await plugin.register(ctx);
    // Plugin-produced tools get their audiences from the canonical map, the
    // way registry-build.ts stamps the static allTools. Without it a plugin
    // tool listed there has no audiences, fails the audience filter and is
    // reachable only through the RAG step.
    applyAudiences(produced);
    const kept: ToolDefinition[] = [];
    const duplicates: string[] = [];
    for (const tool of produced) {
      if (seen.has(tool.name)) duplicates.push(tool.name);
      else { seen.add(tool.name); kept.push(tool); }
    }
    yield { plugin, produced, kept, duplicates };
  }
}
