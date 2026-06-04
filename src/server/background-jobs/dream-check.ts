import { type AgentOptions } from "../../providers/types.js";
import { runAgentViaCanonical } from "../../canonical-loop/agent-runner.js";
import { SecurityLayer } from "../../security/index.js";
import type { LAXConfig, Session, ToolDefinition } from "../../types.js";
import type { SessionStore } from "../../memory/index.js";
import type { SecretsStore } from "../../secrets.js";
import type { ToolPolicy } from "../../tool-policy.js";
import { createLogger } from "../../logger.js";
import { DREAM_SYSTEM_PROMPT } from "./prompts.js";
import type { ProviderId } from "../../providers/provider-ids.js";
import { registerDreamRunner, type DreamRunResult } from "../../memory/dream.js";

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

/**
 * Register the agentic dream as the on-demand runner. It captures the heavy
 * server deps in a closure so the scheduler, the memory_dream tool, and the
 * POST /memory/dream route can all invoke it through triggerDream() without
 * holding those deps. This is the ONLY caller of the dream-state lock.
 */
export function registerDreamRunnerForServer(deps: DreamCheckDeps): void {
  const { config, dataDir, sessionStore, secretsStore, security, toolPolicy, allAgentTools, saveSession } = deps;

  registerDreamRunner(async ({ force }): Promise<DreamRunResult> => {
    const {
      shouldDream, buildDreamPrompt, buildDreamPromptForBatch,
      listRecentSessionTranscripts, buildDreamBatches,
      startDream, completeDream, failDream,
    } = await import("../../memory/dream.js");

    // `force` drops the time/session thresholds but still honors the lock +
    // 30-min crash recovery encoded in shouldDream(minHours, minSessions).
    const gate = force ? shouldDream(0, 0) : shouldDream();
    if (!gate) {
      return { ran: false, reason: force ? "already running" : "gated", batches: 0, sessionsReviewed: 0 };
    }

    logger.info(`[dream] Starting memory consolidation${force ? " (forced)" : ""}...`);
    startDream();
    try {
      const { resolveProvider: rp } = await import("../../agent-request/index.js");
      const { provider, apiKey, model } = await rp(config, secretsStore, dataDir);
      const { backgroundModelFor } = await import("../../providers/registry.js");
      // Dream is background memory consolidation — a cheap, non-reasoning
      // model per provider, not the user's flagship default.
      const dreamModel = backgroundModelFor(provider as ProviderId, model);
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
      return { ran: true, batches: batches.length, sessionsReviewed: recentCount };
    } catch (e) {
      logger.warn("[dream] Failed:", (e as Error).message);
      failDream();
      return { ran: false, reason: `error: ${(e as Error).message}`, batches: 0, sessionsReviewed: 0 };
    }
  });

  logger.info("[dream] Runner registered");
}
