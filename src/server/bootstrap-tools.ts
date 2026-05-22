import { allTools } from "../tools.js";
import { unifiedRegistry } from "../tools/registry.js";
import { plugins, BRIDGE_PLUGIN_IDS } from "../tools/plugins.js";
import type { CronService } from "../cron-service.js";
import type { SecretsStore } from "../secrets.js";
import type { ServerEvent, ToolDefinition } from "../types.js";
import type { UnifiedToolRegistry } from "../tools/registry.js";
import type { MemoryIndex } from "../memory.js";
import type { ToolPluginContext } from "../tools/plugin.js";

import { createLogger } from "../logger.js";
const logger = createLogger("server.bootstrap-tools");

export type EventCallback = (event: ServerEvent) => void;

export interface RuntimeInfo {
  provider: string;
  model: string;
}

export interface ToolBundle {
  allAgentTools: ToolDefinition[];
  bridgeTools: ToolDefinition[];
  toolRegistry: UnifiedToolRegistry;
  activeOnEventBySession: Map<string, EventCallback>;
  activeBrowserSessionIdRef: { value: string };
  /** Per-session resolved provider+model from the chat's PreparedAgentRequest.
   *  Same shape/lifetime as activeOnEventBySession — set by run-chat-turn
   *  after prepareAgentRequest, cleared in the turn's finally. Read by tools
   *  that decide subprocess provider (build_app) so they honor the chat's
   *  active CLI choice instead of the on-disk default in ~/.lax/settings.json. */
  activeRuntimeBySession: Map<string, RuntimeInfo>;
}

export async function bootstrapTools(deps: {
  secretsStore: SecretsStore;
  cronService: CronService;
  memoryIndex: MemoryIndex;
  dataDir: string;
}): Promise<ToolBundle> {
  const activeOnEventBySession = new Map<string, EventCallback>();
  const activeRuntimeBySession = new Map<string, RuntimeInfo>();
  const activeBrowserSessionIdRef: { value: string } = { value: "default" };
  const toolRegistry: UnifiedToolRegistry = unifiedRegistry;

  const ctx: ToolPluginContext = {
    secretsStore: deps.secretsStore,
    memoryIndex: deps.memoryIndex,
    cronService: deps.cronService,
    dataDir: deps.dataDir,
    activeOnEventBySession,
    activeBrowserSessionIdRef,
    activeRuntimeBySession,
    registry: toolRegistry,
  };

  const allAgentTools: ToolDefinition[] = [];
  const outputsById = new Map<string, ToolDefinition[]>();
  const seenTools = new Set<string>();

  for (const plugin of plugins) {
    const produced = await plugin.register(ctx);
    outputsById.set(plugin.id, produced);
    for (const tool of produced) {
      if (seenTools.has(tool.name)) {
        logger.warn(`[tools] Duplicate tool name: "${tool.name}" — later definition wins (plugin=${plugin.id})`);
      }
      seenTools.add(tool.name);
      allAgentTools.push(tool);
      if (toolRegistry.get(tool.name)) continue;
      toolRegistry.register(tool, {
        defer: plugin.defer ?? true,
        tags: plugin.tags ?? [],
        searchHint: tool.description.slice(0, 80),
        toolClass: plugin.toolClass,
      });
    }
  }

  // bridgeTools = the same subset chat-runner has always read: core's
  // allTools plus the plugins flagged in BRIDGE_PLUGIN_IDS.
  const bridgeTools: ToolDefinition[] = [...allTools];
  for (const id of BRIDGE_PLUGIN_IDS) {
    const tools = outputsById.get(id);
    if (tools) bridgeTools.push(...tools);
  }

  try {
    const { MCPManager } = await import("../mcp-client.js");
    const mcpManager = MCPManager.getInstance(deps.dataDir);
    await mcpManager.connectAll();
    mcpManager.startConfigWatcher();
    const mcpTools = mcpManager.getAllTools();
    // Filter redundant filesystem MCP tools — native `read`/`write`/`edit`/
    // `bash` already cover read/write/edit/list/search with full audit and
    // SecurityLayer integration. Exposing both surfaces to the model doubles
    // tool noise and lets weak models pick the MCP variant which tool-policy
    // then denies (since MCP tools default-deny). MCP earns its keep when it
    // adds NEW capabilities — not when it duplicates the native filesystem.
    const nonRedundantMcpTools = mcpTools.filter(t => !t.name.startsWith("mcp_filesystem_"));
    const filteredCount = mcpTools.length - nonRedundantMcpTools.length;
    if (nonRedundantMcpTools.length > 0) {
      allAgentTools.push(...nonRedundantMcpTools);
      for (const tool of nonRedundantMcpTools) {
        const serverName = tool.name.replace(/^mcp_/, "").split("_")[0] ?? "unknown";
        toolRegistry.register(tool, {
          defer: true,
          tags: ["mcp", serverName],
          searchHint: tool.description.slice(0, 80),
          mcpSource: serverName,
        });
      }
      logger.info(`[mcp] Added ${nonRedundantMcpTools.length} tools from MCP servers${filteredCount > 0 ? ` (filtered ${filteredCount} redundant filesystem duplicates)` : ""}`);
    } else if (filteredCount > 0) {
      logger.info(`[mcp] Filtered ${filteredCount} redundant filesystem MCP tools (native covers these)`);
    }
    process.on("SIGINT", () => { mcpManager.disconnectAll(); });
  } catch (e) {
    logger.warn(`[mcp] MCP client init failed: ${(e as Error).message}`);
  }

  return { allAgentTools, bridgeTools, toolRegistry, activeOnEventBySession, activeBrowserSessionIdRef, activeRuntimeBySession };
}
