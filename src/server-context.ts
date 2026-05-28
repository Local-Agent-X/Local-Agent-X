import type { IncomingMessage, ServerResponse } from "node:http";
import type { SecurityLayer } from "./security/index.js";
import type { ToolPolicy } from "./tool-policy.js";
import type { RBACManager, Role } from "./rbac.js";
import type { SessionStore, MemoryIndex, MemoryManager } from "./memory/index.js";
import type { SecretsStore } from "./secrets.js";
import type { CronService } from "./cron/cron-service.js";
import type { IntegrationRegistry } from "./integrations/index.js";
import type { WhatsAppBridge } from "./whatsapp-bridge/index.js";
import type { TelegramBridge } from "./telegram-bridge/index.js";
import type { AgentSync } from "./sync/index.js";
import type { AppRegistry } from "./app-runtime/index.js";
import type { AgentRunStore, AgentTemplateStore, IssueStore, ProjectStore } from "./agent-store/index.js";
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
  chatWs: { startChat: (sessionId: string) => { onEvent: (event: ServerEvent) => void; abort: AbortController }; getActiveChats: () => string[]; stopChat: (sessionId: string) => boolean; getAbortSignal: (sessionId: string) => AbortSignal | undefined; failChat: (sessionId: string, errorMessage: string) => void; emit: (sessionId: string, event: ServerEvent) => void };
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
  /**
   * Per-session runtime provider+model, set by the chat turn handler from
   * the resolved `PreparedAgentRequest`. Tools spawned during the turn read
   * this to honor the chat's active provider (e.g. build_app subprocess CLI
   * choice) rather than the on-disk default in ~/.lax/settings.json.
   * Undefined when the tool is invoked outside a chat turn (cron, bridges,
   * headless ops); downstream then falls back to settings.json — same as
   * before this field existed. Stored in a session-keyed map so concurrent
   * chats don't clobber each other (same shape as activeOnEventBySession).
   */
  getActiveRuntime: (sessionId: string) => { provider: string; model: string } | undefined;
  setActiveRuntime: (sessionId: string, runtime: { provider: string; model: string } | undefined) => void;
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
