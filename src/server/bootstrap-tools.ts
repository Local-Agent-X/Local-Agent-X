import { allTools } from "../tools.js";
import { unifiedRegistry } from "../tools/registry.js";
import { plugins, BRIDGE_PLUGIN_IDS } from "../tools/plugins.js";
import type { CronService } from "../cron-service.js";
import type { SecretsStore } from "../secrets.js";
import type { ServerEvent, ToolDefinition } from "../types.js";
import type { UnifiedToolRegistry } from "../tools/registry.js";
import type { MemoryIndex } from "../memory/index.js";
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

  // Stamp audiences on plugin-produced tools from the canonical map,
  // same as registry-build.ts does for the static allTools. Without
  // this, plugin tools have `audiences === undefined` even when listed
  // in AUDIENCES_BY_TOOL, so they fail the audience filter in
  // tool-search.ts:82 and miss corePinned in tool-selection.ts:105.
  // Symptom: agent_create / project_create only reach the model via
  // the RAG semantic step — whichever sibling has higher embedding
  // similarity wins the slot, often leaving the right tool out.
  const { applyAudiences } = await import("../tools/audience-map.js");

  for (const plugin of plugins) {
    const produced = await plugin.register(ctx);
    applyAudiences(produced);
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
    const { MCPManager } = await import("../mcp-client/index.js");
    const mcpManager = MCPManager.getInstance(deps.dataDir);
    await mcpManager.connectAll();
    mcpManager.startConfigWatcher();
    const mcpTools = mcpManager.getAllTools();
    // Redundant servers (filesystem) are skipped at connect time —
    // see REDUNDANT_MCP_SERVERS in src/mcp-client.ts. Native `read`/
    // `write`/`edit`/`bash` already cover those surfaces with full
    // SecurityLayer integration, and connecting just to drop the tools
    // cost ~12s of subprocess spawn on every boot.
    if (mcpTools.length > 0) {
      allAgentTools.push(...mcpTools);
      for (const tool of mcpTools) {
        const serverName = tool.name.replace(/^mcp_/, "").split("_")[0] ?? "unknown";
        toolRegistry.register(tool, {
          defer: true,
          tags: ["mcp", serverName],
          searchHint: tool.description.slice(0, 80),
          mcpSource: serverName,
        });
      }
      logger.info(`[mcp] Added ${mcpTools.length} tools from MCP servers`);
    }
    process.on("SIGINT", () => { mcpManager.disconnectAll(); });
  } catch (e) {
    logger.warn(`[mcp] MCP client init failed: ${(e as Error).message}`);
  }

  return { allAgentTools, bridgeTools, toolRegistry, activeOnEventBySession, activeBrowserSessionIdRef, activeRuntimeBySession };
}
