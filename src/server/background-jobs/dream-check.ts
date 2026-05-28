import { type AgentOptions } from "../../providers/types.js";
import { runAgentViaCanonical } from "../../canonical-loop/agent-runner.js";
import { SecurityLayer } from "../../security/index.js";
import type { LAXConfig, Session, ToolDefinition } from "../../types.js";
import type { SessionStore } from "../../memory/index.js";
import type { SecretsStore } from "../../secrets.js";
import type { ToolPolicy } from "../../tool-policy.js";
import { createLogger } from "../../logger.js";
import { DREAM_SYSTEM_PROMPT } from "./prompts.js";

const logger = createLogger("server.background-jobs.dream");

export interface DreamCheckDeps {
  config: LAXConfig;
  dataDir: string;
  sessionStore: SessionStore;
  secretsStore: SecretsStore;
  security: SecurityLayer;
  toolPolicy: ToolPolicy;
  allAgentTools: ToolDefinition[];
  saveSession: (s: Session) => Promise<void>;
}

export function makeRunDreamCheck(deps: DreamCheckDeps): () => Promise<void> {
  const { config, dataDir, sessionStore, secretsStore, security, toolPolicy, allAgentTools, saveSession } = deps;
  return async () => {
    try {
      const {
        shouldDream, buildDreamPrompt, buildDreamPromptForBatch,
        listRecentSessionTranscripts, buildDreamBatches,
        startDream, completeDream,
      } = await import("../../memory/dream.js");
      if (!shouldDream()) return;
      logger.info("[dream] Starting memory consolidation...");
      startDream();
      const { resolveProvider: rp } = await import("../../agent-request/index.js");
      const { provider, apiKey, model } = await rp(config, secretsStore, dataDir);
      const dreamModel = provider === "anthropic" ? "claude-haiku-4-5" : model;
      const dreamSession: Session = { id: `dream-${Date.now()}`, title: "Memory Dream", messages: [], createdAt: Date.now(), updatedAt: Date.now() };
      const dreamTools = allAgentTools.filter(t => ["read", "write", "edit", "glob", "grep", "memory_search", "memory_save"].includes(t.name));

      const transcripts = listRecentSessionTranscripts(10);
      const batches = transcripts.length > 0 ? buildDreamBatches(transcripts) : [];

      if (batches.length === 0) {
        const result = await runAgentViaCanonical(buildDreamPrompt(), [], {
          apiKey, model: dreamModel, provider: provider as AgentOptions["provider"],
          systemPrompt: DREAM_SYSTEM_PROMPT, tools: dreamTools, security, toolPolicy,
          sessionId: dreamSession.id, maxIterations: 10, temperature: 0.3,
          opType: "memory_consolidation", lane: "background",
        });
        dreamSession.messages.push(...result.messages.filter(m => m.role !== "system"));
      } else {
        for (let i = 0; i < batches.length; i++) {
          const prompt = buildDreamPromptForBatch(batches[i], i, batches.length);
          const result = await runAgentViaCanonical(prompt, [], {
            apiKey, model: dreamModel, provider: provider as AgentOptions["provider"],
            systemPrompt: DREAM_SYSTEM_PROMPT, tools: dreamTools, security, toolPolicy,
            sessionId: `${dreamSession.id}-b${i}`, maxIterations: 15, temperature: 0.3,
            opType: "memory_consolidation", lane: "background",
          });
          dreamSession.messages.push(...result.messages.filter(m => m.role !== "system"));
        }
      }

      dreamSession.updatedAt = Date.now();
      saveSession(dreamSession);

      try {
        const { getUniversalIndex } = await import("../../memory/universal-index.js");
        const ui = getUniversalIndex();
        if (ui) {
          const report = await ui.backfillAll();
          if (report.totalChunksAdded > 0) {
            logger.info(`[dream] Post-dream reindex: +${report.totalChunksAdded} chunks across ${report.totalFilesScanned} files`);
          }
        }
      } catch (e) { logger.warn("[dream] Post-dream reindex failed:", (e as Error).message); }

      const recentCount = sessionStore.list().filter(s => s.updatedAt > Date.now() - 24 * 60 * 60 * 1000).length;
      completeDream(recentCount);
      logger.info(`[dream] Memory consolidation finished (${batches.length} batch(es))`);
    } catch (e) {
      logger.warn("[dream] Failed:", (e as Error).message);
      try { const { failDream } = await import("../../memory/dream.js"); failDream(); } catch {}
    }
  };
}
