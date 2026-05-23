import { existsSync } from "node:fs";
import { join } from "node:path";
import { type AgentOptions } from "../../providers/types.js";
import { runAgentViaCanonical } from "../../canonical-loop/agent-runner.js";
import { stripEphemeralMessages } from "../../providers/sanitize.js";
import { extractAgentOutput } from "../../server-utils.js";
import { SecurityLayer } from "../../security.js";
import type { LAXConfig, Session, ToolDefinition } from "../../types.js";
import type { SecretsStore } from "../../secrets.js";
import type { ToolPolicy } from "../../tool-policy.js";
import { createLogger } from "../../logger.js";
import { WORKER_SYSTEM_PROMPT_TEMPLATE } from "./prompts.js";

const logger = createLogger("server.background-jobs.workers");

export interface WorkerRunnerDeps {
  config: LAXConfig;
  dataDir: string;
  secretsStore: SecretsStore;
  security: SecurityLayer;
  toolPolicy: ToolPolicy;
  allAgentTools: ToolDefinition[];
  getOrCreateSession: (id: string) => Session;
  saveSession: (s: Session) => Promise<void>;
}

export function registerWorkerRunnerForServer(deps: WorkerRunnerDeps): void {
  const { config, dataDir, secretsStore, security, toolPolicy, allAgentTools, getOrCreateSession, saveSession } = deps;
  import("../../worker-session.js").then(({ registerWorkerRunner }) => {
    registerWorkerRunner(async (workerSession, message) => {
      const { resolveProvider } = await import("../../agent-request.js");
      const sessionId = workerSession.id;
      const { provider, apiKey, model } = await resolveProvider(config, secretsStore, dataDir);

      const workerPrompt = WORKER_SYSTEM_PROMPT_TEMPLATE(workerSession.workingDir);
      const workerTools = allAgentTools.filter(t =>
        ["read", "write", "edit", "bash", "glob", "grep", "web_fetch", "web_search", "view_image"].includes(t.name)
      );
      const session = getOrCreateSession(sessionId);
      const hasExistingApp = existsSync(join(workerSession.workingDir, "index.html"));
      const history = hasExistingApp ? session.messages.slice(-10) : [];
      const result = await runAgentViaCanonical(message, history, {
        apiKey, model,
        provider: provider as AgentOptions["provider"],
        systemPrompt: workerPrompt, tools: workerTools,
        security, toolPolicy, sessionId,
        maxIterations: 15,
        opType: "app_builder",
        lane: "background",
      });
      session.messages = stripEphemeralMessages(result.messages).filter(m => m.role !== "system");
      session.updatedAt = Date.now(); saveSession(session);
      return extractAgentOutput(result.messages);
    });
    logger.info("[workers] Runner registered");
  }).catch(() => {});
}
