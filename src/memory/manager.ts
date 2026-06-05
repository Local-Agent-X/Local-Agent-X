/**
 * MemoryManager — single facade for the memory subsystem.
 *
 * Replaces ad-hoc combinations of buildContextBlock + autoSearchContext +
 * processMessage + autoExtractAndSave + appendDailyLog scattered across the
 * agent loop. Callers depend on this class instead of reaching into individual
 * memory modules.
 *
 * Underlying machinery (MemoryIndex, MemoryOrchestrator, etc.) stays accessible
 * for routes and background jobs that legitimately need lower-level operations.
 */

import type { MemoryIndex } from "./index-core.js";
import type { FactKind, MemorySearchResult, RetainedFact } from "./types.js";
import type { SearchOptions } from "./index-search.js";
import { buildContextBlock, autoSearchContext } from "./context.js";
import { autoExtractAndSave } from "./auto-extract.js";
import { findKnownProjectsInMessage, buildKnownProjectsNudge } from "./known-projects.js";
import { appendToDailyLogSafely } from "./write-safely.js";
import { getSessionProject } from "../session/project.js";
import { createLogger } from "../logger.js";

const logger = createLogger("memory.manager");

export interface TurnContextInput {
  userMessage: string;
  sessionId: string;
  sessionMessages: Array<{ role: string; content: string }>;
  /** Codex-only: skip daily-log injection (OpenAI moderation tripping risk). */
  skipDailyLog?: boolean;
  /** Skip the orchestrator + semantic search; basic context block only. */
  liteMode?: boolean;
  /** Skip everything except buildContextBlock (bridges/cron lightweight path). */
  minimalMode?: boolean;
}

export interface TurnContext {
  contextBlock: string;
  relevantMemories: string;
  /**
   * @deprecated Always empty. Cross-session summaries are no longer
   * auto-injected; the model must call `search_past_sessions` explicitly.
   * Kept on the type to avoid breaking call sites until they migrate.
   */
  smartContext: string;
  memoryContext: string;
  notifications: Array<{ type: string; message: string; priority: number }>;
}

export interface PersistTurnInput {
  userMessage: string;
  agentResponse: string;
  /** Skip auto-extraction + daily log (trivial tool requests). */
  skip?: boolean;
  /** Tag the daily-log entry so today_context can filter by current session. */
  sessionId?: string;
}

export type RecallBy = "entity" | "kind" | "time";

export class MemoryManager {
  constructor(private readonly index: MemoryIndex) {}

  /**
   * Build everything memory contributes to a single agent turn.
   * Aggregates context block, semantic search, session-summary recall, and
   * orchestrator output. Failures in any one path degrade gracefully — the
   * other paths still return their content.
   */
  async buildTurnContext(input: TurnContextInput): Promise<TurnContext> {
    const out: TurnContext = {
      contextBlock: "",
      relevantMemories: "",
      smartContext: "",
      memoryContext: "",
      notifications: [],
    };

    // The active project for this session, if the chat is nested under one.
    // Threaded into buildContextBlock so the project's brief is injected.
    const projectId = getSessionProject(input.sessionId);

    if (input.minimalMode) {
      try {
        out.contextBlock = await buildContextBlock(this.index, { sessionId: input.sessionId, projectId });
      } catch (e) {
        logger.warn("buildContextBlock (minimal) failed:", (e as Error).message);
      }
      return out;
    }

    if (input.liteMode) {
      try {
        out.contextBlock = await buildContextBlock(this.index, {
          skipDailyLog: input.skipDailyLog,
          userMessage: input.userMessage,
          sessionId: input.sessionId,
          projectId,
        });
      } catch (e) {
        logger.warn("buildContextBlock (lite) failed:", (e as Error).message);
      }
      return out;
    }

    // Parallelize the four independent memory operations. Sequencing them
    // turned cold-cache turns into 60-90s freezes — buildContextBlock,
    // autoSearchContext, known-projects scan, and the orchestrator each
    // spend significant time on disk + embedding queries, but they don't
    // depend on each other's results. Running them concurrently turns the
    // tail-latency-bound serial chain into a ceiling at the slowest single
    // op (typically buildContextBlock at ~10-20s, others ~3-8s).
    //
    // smartContext is intentionally left empty by default. Cross-session
    // summary recall moved to the explicit `search_past_sessions` tool —
    // the prior keyword-grep auto-inject was the root cause of recurring
    // cross-conversation bleed.
    out.smartContext = "";
    const lastAssistant = input.sessionMessages.filter((m) => m.role === "assistant").pop()?.content;
    const [contextBlock, relevantMemories, knownProjectsNudge, orch] = await Promise.all([
      buildContextBlock(this.index, {
        userMessage: input.userMessage,
        skipDailyLog: input.skipDailyLog,
        sessionId: input.sessionId,
        projectId,
      }).catch((e) => {
        logger.warn("buildContextBlock failed:", (e as Error).message);
        return "";
      }),
      autoSearchContext(this.index, input.userMessage, { sessionId: input.sessionId }).catch((e) => {
        logger.warn("autoSearchContext failed:", (e as Error).message);
        return "";
      }),
      // Known-project recall trigger. One-line nudge when user mentions a
      // domain/project name we have prior content for. Bleed-safe — the
      // model has to call search_past_sessions explicitly to get content.
      findKnownProjectsInMessage(this.index, input.userMessage, {
        currentSessionId: input.sessionId,
      }).then(buildKnownProjectsNudge).catch((e) => {
        logger.warn("known-projects scan failed:", (e as Error).message);
        return "";
      }),
      // Orchestrator (signal modules + LLM classifiers under tight
      // timeouts). Returns null on failure; we treat that as "no
      // memory context to inject."
      (async () => {
        try {
          const { processMessage } = await import("../orchestrator/process-message.js");
          return await processMessage({
            message: input.userMessage,
            sessionId: input.sessionId,
            sessionMessages: input.sessionMessages,
            timeOfDay: new Date().getHours(),
            dayOfWeek: new Date().getDay(),
            agentPreviousMessage: lastAssistant || undefined,
          });
        } catch (e) {
          logger.warn("Orchestrator failed:", (e as Error).message);
          return null;
        }
      })(),
    ]);

    out.contextBlock = contextBlock;
    out.relevantMemories = relevantMemories;
    if (knownProjectsNudge) out.smartContext = knownProjectsNudge;
    if (orch) {
      out.memoryContext = orch.contextInjection ? `\n\n${orch.contextInjection}` : "";
      out.notifications = orch.notifications || [];
      if (orch.debug) {
        logger.info(
          `Orchestrator: ${orch.debug.modulesActivated.length} modules, ${orch.debug.totalTimeMs}ms`,
        );
      }
    }

    return out;
  }

  /**
   * Post-turn: extract durable facts from the exchange and append a daily-log
   * entry. Skipped for trivial tool requests.
   */
  async persistTurn(input: PersistTurnInput): Promise<void> {
    if (input.skip) return;
    try {
      await autoExtractAndSave(this.index, input.userMessage, input.agentResponse, input.sessionId);
    } catch (e) {
      logger.warn("autoExtractAndSave failed:", (e as Error).message);
    }
    try {
      const userSnippet = input.userMessage.slice(0, 300).replace(/\n/g, " ");
      if (userSnippet.length > 10) {
        appendToDailyLogSafely({
          memory: this.index,
          source: "auto-extract",
          content: `User: ${userSnippet}`,
          sessionId: input.sessionId,
        });
      }
    } catch (e) {
      logger.warn("appendDailyLog failed:", (e as Error).message);
    }
  }

  /** Tool-layer semantic search. */
  search(query: string, options?: SearchOptions): Promise<MemorySearchResult[]> {
    return this.index.search(query, options);
  }

  /** Tool-layer fact retention. */
  retain(text: string, sourceFile: string, sourceLine = 0): RetainedFact[] {
    return this.index.retain(text, sourceFile, sourceLine);
  }

  /** Tool-layer recall by entity slug, fact kind, or time window. */
  recall(
    by: "entity",
    query: string,
    opts?: { limit?: number; includeInvalidated?: boolean },
  ): RetainedFact[];
  recall(
    by: "kind",
    query: FactKind,
    opts?: { limit?: number; includeInvalidated?: boolean },
  ): RetainedFact[];
  recall(
    by: "time",
    query: Date,
    opts?: { limit?: number; includeInvalidated?: boolean; until?: Date },
  ): RetainedFact[];
  recall(
    by: RecallBy,
    query: string | Date | FactKind,
    opts: { limit?: number; includeInvalidated?: boolean; until?: Date } = {},
  ): RetainedFact[] {
    const limit = opts.limit;
    const flags = { includeInvalidated: opts.includeInvalidated };
    if (by === "entity") return this.index.recallByEntity(query as string, limit ?? 20, flags);
    if (by === "kind") return this.index.recallByKind(query as FactKind, limit ?? 20, flags);
    return this.index.recallByTime(query as Date, opts.until, limit ?? 50, flags);
  }

  /** Background consolidation, compression, tier reclassification. */
  async runBackground(): Promise<import("../orchestrator/types.js").BackgroundReport> {
    const { MemoryOrchestrator } = await import("../orchestrator/orchestrator.js");
    return MemoryOrchestrator.getInstance().runBackground(this.index);
  }

}
