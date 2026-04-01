import type { IncomingMessage, ServerResponse } from "node:http";
import type { SecurityLayer } from "./security.js";
import type { ToolPolicy } from "./tool-policy.js";
import type { RBACManager, Role } from "./rbac.js";
import type { SessionStore, MemoryIndex } from "./memory.js";
import type { SecretsStore } from "./secrets.js";
import type { CronService } from "./cron-service.js";
import type { IntegrationRegistry } from "./integrations.js";
import type { WhatsAppBridge } from "./whatsapp-bridge.js";
import type { TelegramBridge } from "./telegram-bridge.js";
import type { AgentSync } from "./sync.js";
import type { AppRegistry } from "./app-runtime.js";
import type { AgentRunStore, AgentTemplateStore, IssueStore, ProjectStore } from "./agent-store.js";
import type { ToolDefinition, SAXConfig, ServerEvent, Session } from "./types.js";

export interface ServerContext {
  config: SAXConfig;
  security: SecurityLayer;
  toolPolicy: ToolPolicy;
  rbac: RBACManager;
  dataDir: string;
  publicDir: string;
  sessionStore: SessionStore;
  memoryIndex: MemoryIndex;
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
  bridgeTools: ToolDefinition[];
  getOrCreateSession: (id: string) => Session;
  saveSession: (session: Session) => void;
  chatWs: { startChat: (sessionId: string) => { onEvent: (event: ServerEvent) => void; abort: AbortController }; getActiveChats: () => string[] };
  broadcastAll: (event: any) => void;
  activeOnEvent: ((event: ServerEvent) => void) | undefined;
  setActiveOnEvent: (fn: ((event: ServerEvent) => void) | undefined) => void;
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
