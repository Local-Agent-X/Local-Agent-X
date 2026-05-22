import type { ToolClass } from "@arikernel/core";
import type { ToolDefinition, ServerEvent } from "../types.js";
import type { SecretsStore } from "../secrets.js";
import type { MemoryIndex } from "../memory.js";
import type { CronService } from "../cron-service.js";
import type { UnifiedToolRegistry } from "./registry.js";

export type EventCallback = (event: ServerEvent) => void;

export interface RuntimeInfo {
  provider: string;
  model: string;
}

export interface ToolPluginContext {
  secretsStore: SecretsStore;
  memoryIndex: MemoryIndex;
  cronService: CronService;
  dataDir: string;
  activeOnEventBySession: Map<string, EventCallback>;
  activeBrowserSessionIdRef: { value: string };
  activeRuntimeBySession: Map<string, RuntimeInfo>;
  registry: UnifiedToolRegistry;
}

export interface ToolPlugin {
  id: string;
  register(ctx: ToolPluginContext): ToolDefinition[] | Promise<ToolDefinition[]>;
  /** Whether tools are deferred (tool_search only) or eager (visible in per-request schema). Default true. */
  defer?: boolean;
  tags?: string[];
  toolClass?: ToolClass;
  /** When true, plugin tools are also included in bridgeTools[] (chat-runner subset). */
  bridge?: boolean;
}
