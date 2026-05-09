import type { IncomingMessage, ServerResponse } from "node:http";
import type { SecurityLayer } from "./security.js";
import type { ToolPolicy } from "./tool-policy.js";
import type { RBACManager, Role } from "./rbac.js";
import type { SessionStore, MemoryIndex, MemoryManager } from "./memory.js";
import type { SecretsStore } from "./secrets.js";
import type { CronService } from "./cron-service.js";
import type { IntegrationRegistry } from "./integrations.js";
import type { WhatsAppBridge } from "./whatsapp-bridge.js";
import type { TelegramBridge } from "./telegram-bridge.js";
import type { AgentSync } from "./sync.js";
import type { AppRegistry } from "./app-runtime.js";
import type { AgentRunStore, AgentTemplateStore, IssueStore, ProjectStore } from "./agent-store.js";
import type { ToolDefinition, LAXConfig, ServerEvent, Session } from "./types.js";
import type { ToolRegistry } from "./tool-search.js";

export interface ServerContext {
  config: LAXConfig;
  security: SecurityLayer;
  toolPolicy: ToolPolicy;
  rbac: RBACManager;
  dataDir: string;
  publicDir: string;
  sessionStore: SessionStore;
  memoryIndex: MemoryIndex;
  memoryManager: MemoryManager;
  secretsStore: SecretsStore;
  cronService: CronService;
  integrations: IntegrationRegistry;
  whatsappBridge: WhatsAppBridge;
  telegramBridge: TelegramBridge;
  agentSync: AgentSync;
  appRegistry: AppRegistry;
  agentRunStore: AgentRunStore;
  agentTemplateStore: AgentTemplateStore;
  issueStore: IssueStore;
  projectStore: ProjectStore;
  allAgentTools: ToolDefinition[];
  toolRegistry?: ToolRegistry;
  bridgeTools: ToolDefinition[];
  getOrCreateSession: (id: string) => Session;
  saveSession: (session: Session) => Promise<void>;
  flushSession: (id: string) => Promise<void>;
  chatWs: { startChat: (sessionId: string) => { onEvent: (event: ServerEvent) => void; abort: AbortController }; getActiveChats: () => string[]; stopChat: (sessionId: string) => boolean; getAbortSignal: (sessionId: string) => AbortSignal | undefined };
  broadcastAll: (event: Record<string, unknown>) => void;
  /**
   * Per-session active event callback registry. Tools that emit progress events
   * look up the callback for the session they were invoked from, instead of
   * reading a single global. Prevents cross-session event leakage when multiple
   * chats run concurrently.
   */
  getActiveOnEvent: (sessionId: string) => ((event: ServerEvent) => void) | undefined;
  setActiveOnEvent: (sessionId: string, fn: ((event: ServerEvent) => void) | undefined) => void;
  activeBrowserSessionId: string;
  setActiveBrowserSessionId: (id: string) => void;
}

/** Standard route handler signature — returns true if handled */
export type RouteHandler = (
  method: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
  requestRole: Role
) => Promise<boolean>;
