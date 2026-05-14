import { allTools, createHttpRequestTool, buildToolRegistry } from "../tools.js";
import { appTools } from "../app-tools.js";
import { issueTools } from "../issue-tools.js";
import { createSecretTools } from "../secret-tools.js";
import { createBrowserTools } from "../browser-tools.js";
import { imageTools } from "../image-tools.js";
import { createCoreProtocolTools } from "../protocols.js";
import { CronService, createCronTools } from "../cron-service.js";
import { createAgencyTools } from "../agency/index.js";
import { createHandlerTools } from "../agency/handler.js";
import { createAgentTools } from "../agents/tools.js";
import { createMemoryTools } from "../memory.js";
import type { SecretsStore } from "../secrets.js";
import type { ServerEvent, ToolDefinition } from "../types.js";
import type { UnifiedToolRegistry } from "../tools/registry.js";
import type { MemoryIndex } from "../memory.js";

import { createLogger } from "../logger.js";
const logger = createLogger("server.bootstrap-tools");

export type EventCallback = (event: ServerEvent) => void;

export interface ToolBundle {
  allAgentTools: ToolDefinition[];
  bridgeTools: ToolDefinition[];
  toolRegistry: UnifiedToolRegistry;
  activeOnEventBySession: Map<string, EventCallback>;
  activeBrowserSessionIdRef: { value: string };
}

export async function bootstrapTools(deps: {
  secretsStore: SecretsStore;
  cronService: CronService;
  memoryIndex: MemoryIndex;
  dataDir: string;
}): Promise<ToolBundle> {
  const { secretsStore, cronService, memoryIndex, dataDir } = deps;
  const memoryTools = createMemoryTools(memoryIndex);

  const activeOnEventBySession = new Map<string, EventCallback>();
  // request_secret / request_secrets need to emit events back to the calling
  // session. We look up the session callback at execute time using
  // args._sessionId (injected by the tool executor for SESSION_SCOPED_TOOLS).
  const secretTools = createSecretTools(secretsStore, undefined);
  const SESSION_ONEVENT_TOOLS = new Set(["request_secret", "request_secrets"]);
  for (let i = 0; i < secretTools.length; i++) {
    if (!SESSION_ONEVENT_TOOLS.has(secretTools[i].name)) continue;
    const toolName = secretTools[i].name;
    secretTools[i].execute = async (args, signal) => {
      const sessionId = args._sessionId ? String(args._sessionId) : "";
      const onEvent = sessionId ? activeOnEventBySession.get(sessionId) : undefined;
      const { createSecretTools: f } = await import("../secret-tools.js");
      const fresh = f(secretsStore, onEvent).find(t => t.name === toolName);
      if (!fresh) throw new Error(`Tool ${toolName} not found`);
      return fresh.execute(args, signal);
    };
  }
  const httpRequestTool = createHttpRequestTool(secretsStore);
  const activeBrowserSessionIdRef: { value: string } = { value: "default" };
  const browserTools = createBrowserTools(() => activeBrowserSessionIdRef.value);
  const { createBrowserSecretCaptureTool } = await import("../browser-secret-capture.js");
  const browserSecretCaptureTool = createBrowserSecretCaptureTool(secretsStore, () => activeBrowserSessionIdRef.value);
  const { createBrowserSecretFillTool } = await import("../browser-secret-fill.js");
  const browserSecretFillTool = createBrowserSecretFillTool(secretsStore, () => activeBrowserSessionIdRef.value);
  const { createSessionStatusTool } = await import("../session-status-tool.js");
  const sessionStatusTool = createSessionStatusTool(() => activeBrowserSessionIdRef.value);
  const { createVoiceVisualTool } = await import("../voice/voice-visual-tool.js");
  const voiceVisualTool = createVoiceVisualTool();
  const { createOperationTools } = await import("../operations/tools.js");
  const operationTools = createOperationTools();
  const { installSoftwareTool } = await import("../tools/install-software.js");
  const { registry: toolRegistry } = buildToolRegistry();

  const allAgentTools: ToolDefinition[] = [
    ...allTools, httpRequestTool, installSoftwareTool,
    ...memoryTools, ...secretTools, browserSecretCaptureTool, browserSecretFillTool, sessionStatusTool, voiceVisualTool, ...browserTools, ...imageTools,
    ...createCoreProtocolTools(), ...createCronTools(cronService),
    ...createAgentTools(), ...createAgencyTools(), ...createHandlerTools(), ...appTools, ...issueTools,
    ...operationTools,
  ];
  const bridgeTools: ToolDefinition[] = [...allTools, ...memoryTools, browserSecretCaptureTool, sessionStatusTool, ...browserTools, ...imageTools, ...createCoreProtocolTools(), ...issueTools];

  try {
    const { MCPManager } = await import("../mcp-client.js");
    const mcpManager = MCPManager.getInstance(dataDir);
    await mcpManager.connectAll();
    // Hot-reload on mcp.json change so new servers / token additions don't
    // need a server restart. Mirrors the existing config-hot-reload pattern
    // for system-prompt.md / tools.json.
    mcpManager.startConfigWatcher();
    const mcpTools = mcpManager.getAllTools();
    // Filter redundant filesystem MCP tools — native `read`/`write`/`edit`/
    // `bash` already cover read/write/edit/list/search with full audit and
    // SecurityLayer integration. Exposing both surfaces to the model
    // doubles tool noise and lets weak models pick the MCP variant which
    // tool-policy then denies (since MCP tools default-deny). Result: the
    // "tried to write a doc file but it was blocked" failure mode. MCP
    // earns its keep when it adds NEW capabilities (GitHub, Postgres,
    // Slack, etc.) — not when it duplicates the native filesystem.
    const nonRedundantMcpTools = mcpTools.filter(t => !t.name.startsWith("mcp_filesystem_"));
    const filteredCount = mcpTools.length - nonRedundantMcpTools.length;
    if (nonRedundantMcpTools.length > 0) {
      allAgentTools.push(...nonRedundantMcpTools);
      // Register MCP tools directly into the unified registry, tagged with
      // their originating server. The previous "register here, then catch
      // up later via a dedup loop" sequence was the F2 anti-pattern — the
      // registry is now the single point of MCP tool insertion.
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

  // Index every other runtime-built tool (memory, secret, browser, image,
  // protocols, cron, agents, agency, app, issue, operations) into the
  // unified registry as deferred — they're surfaced via tool_search rather
  // than the eager schema. allTools[] is already in via buildToolRegistry();
  // MCP tools are already in via the loop above. Anything left over here is
  // a runtime-built non-MCP tool. The `seenTools` warn is the duplicate-
  // name canary that was always part of this loop.
  const seenTools = new Set<string>();
  for (const tool of allAgentTools) {
    if (seenTools.has(tool.name)) {
      logger.warn(`[tools] Duplicate tool name: "${tool.name}" — later definition wins`);
    }
    seenTools.add(tool.name);
    if (toolRegistry.get(tool.name)) continue;
    toolRegistry.register(tool, { defer: true, tags: [], searchHint: tool.description.slice(0, 80) });
  }

  return { allAgentTools, bridgeTools, toolRegistry, activeOnEventBySession, activeBrowserSessionIdRef };
}
