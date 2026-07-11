import type { IncomingMessage, ServerResponse } from "node:http";
import { jsonResponse } from "../server-utils.js";
import { authorizeRequest } from "./request-auth.js";
import { routeApiRequest } from "./api-request-router.js";
import { serveProtectedAssets, servePublicAsset } from "./static-assets.js";
import { serveWorkspaceApp } from "./workspace-app-serving.js";
import type { ServerContext } from "../server-context.js";
import type { LAXConfig, ServerEvent, Session, ToolDefinition } from "../types.js";
import type { SecurityLayer } from "../security/index.js";
import type { ToolPolicy } from "../tool-policy/index.js";
import type { RBACManager } from "../rbac.js";
import type { SessionStore, MemoryIndex, MemoryManager } from "../memory/index.js";
import type { SecretsStore } from "../secrets.js";
import type { CronService } from "../cron/cron-service.js";
import type { IntegrationRegistry } from "../integrations/index.js";
import type { WhatsAppBridge } from "../whatsapp-bridge/index.js";
import type { TelegramBridge } from "../telegram-bridge/index.js";
import type { AgentSync } from "../sync/index.js";
import { localOnlyRouteDecision } from "../local-only-policy.js";
import type { AppRegistry } from "../app-runtime/index.js";
import type { AgentRunStore, AgentTemplateStore, IssueStore, ProjectStore } from "../agent-store/index.js";
import type { ToolRegistry } from "../tools/tool-search.js";

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export interface RequestHandlerDeps {
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
  toolRegistry: ToolRegistry;
  bridgeTools: ToolDefinition[];
  getOrCreateSession: (id: string) => Session;
  saveSession: (session: Session) => Promise<void>;
  flushSession: (id: string) => Promise<void>;
  getChatWs: () => ServerContext["chatWs"];
  broadcastAll: (event: Record<string, unknown>) => void;
  activeOnEventBySession: Map<string, (event: ServerEvent) => void>;
  activeBrowserSessionIdRef: { value: string };
  activeRuntimeBySession: Map<string, { provider: string; model: string }>;
}

function createServerContext(deps: RequestHandlerDeps): ServerContext {
  return {
    config: deps.config, security: deps.security, toolPolicy: deps.toolPolicy, rbac: deps.rbac,
    dataDir: deps.dataDir, publicDir: deps.publicDir, sessionStore: deps.sessionStore,
    memoryIndex: deps.memoryIndex, memoryManager: deps.memoryManager, secretsStore: deps.secretsStore,
    cronService: deps.cronService, integrations: deps.integrations, whatsappBridge: deps.whatsappBridge,
    telegramBridge: deps.telegramBridge, agentSync: deps.agentSync, appRegistry: deps.appRegistry,
    agentRunStore: deps.agentRunStore, agentTemplateStore: deps.agentTemplateStore,
    issueStore: deps.issueStore, projectStore: deps.projectStore, allAgentTools: deps.allAgentTools,
    toolRegistry: deps.toolRegistry, bridgeTools: deps.bridgeTools,
    getOrCreateSession: deps.getOrCreateSession, saveSession: deps.saveSession,
    flushSession: deps.flushSession, chatWs: deps.getChatWs(), broadcastAll: deps.broadcastAll,
    getActiveOnEvent: sid => deps.activeOnEventBySession.get(sid),
    setActiveOnEvent: (sid, fn) => {
      if (fn) deps.activeOnEventBySession.set(sid, fn);
      else deps.activeOnEventBySession.delete(sid);
    },
    activeBrowserSessionId: deps.activeBrowserSessionIdRef.value,
    setActiveBrowserSessionId: id => { deps.activeBrowserSessionIdRef.value = id; },
    getActiveRuntime: sid => deps.activeRuntimeBySession.get(sid),
    setActiveRuntime: (sid, runtime) => {
      if (runtime) deps.activeRuntimeBySession.set(sid, runtime);
      else deps.activeRuntimeBySession.delete(sid);
    },
  };
}

export function createRequestHandler(deps: RequestHandlerDeps): RequestHandler {
  return async (req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${deps.config.port}`);
    const method = req.method || "GET";
    const authorization = authorizeRequest(method, url, req, res, deps.config, deps.rbac);
    if (authorization.handled) return;
    const localOnlyRoute = localOnlyRouteDecision(method, url.pathname);
    if (!localOnlyRoute.allowed) {
      jsonResponse(res, 403, { error: localOnlyRoute.reason, code: "LOCAL_ONLY" }, req);
      return;
    }

    const ctx = createServerContext(deps);
    if (await routeApiRequest(method, url, req, res, ctx, authorization.role, deps.config, deps.dataDir)) return;
    if (serveProtectedAssets(method, url, req, res, deps.config, deps.dataDir)) return;
    if (serveWorkspaceApp(method, url, req, res, deps.config, deps.publicDir)) return;
    if (servePublicAsset(method, url, req, res, deps.publicDir)) return;
    jsonResponse(res, 404, { error: "Not found" }, req);
  };
}
