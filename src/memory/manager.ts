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

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { MemoryIndex } from "./index-core.js";
import type { FactKind, MemorySearchResult, RetainedFact } from "./types.js";
import type { SearchOptions } from "./index-search.js";
import { buildContextBlock, autoSearchContext } from "./context.js";
import { autoExtractAndSave } from "./auto-extract.js";
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
  smartContext: string;
  memoryContext: string;
  notifications: Array<{ type: string; message: string; priority: number }>;
}

export interface PersistTurnInput {
  userMessage: string;
  agentResponse: string;
  /** Skip auto-extraction + daily log (trivial tool requests). */
  skip?: boolean;
}

export type RecallBy = "entity" | "kind" | "time";

export class MemoryManager {
  constructor(
    private readonly index: MemoryIndex,
    private readonly dataDir: string,
  ) {}

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

    if (input.minimalMode) {
      try {
        out.contextBlock = await buildContextBlock(this.index);
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
        });
      } catch (e) {
        logger.warn("buildContextBlock (lite) failed:", (e as Error).message);
      }
      return out;
    }

    const [contextBlock, relevantMemories] = await Promise.all([
      buildContextBlock(this.index, {
        userMessage: input.userMessage,
        skipDailyLog: input.skipDailyLog,
      }).catch((e) => {
        logger.warn("buildContextBlock failed:", (e as Error).message);
        return "";
      }),
      autoSearchContext(this.index, input.userMessage, { sessionId: input.sessionId }).catch((e) => {
        logger.warn("autoSearchContext failed:", (e as Error).message);
        return "";
      }),
    ]);
    out.contextBlock = contextBlock;
    out.relevantMemories = relevantMemories;
    out.smartContext = this.loadSmartContext(input.userMessage);

    try {
      const { processMessage } = await import("../memory-orchestrator.js");
      const orch = await processMessage({
        message: input.userMessage,
        sessionId: input.sessionId,
        sessionMessages: input.sessionMessages,
        timeOfDay: new Date().getHours(),
        dayOfWeek: new Date().getDay(),
        agentPreviousMessage:
          input.sessionMessages.filter((m) => m.role === "assistant").pop()?.content || undefined,
      });
      out.memoryContext = orch.contextInjection ? `\n\n${orch.contextInjection}` : "";
      out.notifications = orch.notifications || [];
      if (orch.debug) {
        logger.info(
          `Orchestrator: ${orch.debug.modulesActivated.length} modules, ${orch.debug.totalTimeMs}ms`,
        );
      }
    } catch (e) {
      logger.warn("Orchestrator failed:", (e as Error).message);
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
      await autoExtractAndSave(this.index, input.userMessage, input.agentResponse);
    } catch (e) {
      logger.warn("autoExtractAndSave failed:", (e as Error).message);
    }
    try {
      const userSnippet = input.userMessage.slice(0, 300).replace(/\n/g, " ");
      if (userSnippet.length > 10) this.index.appendDailyLog(`User: ${userSnippet}`);
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
    const { MemoryOrchestrator } = await import("../memory-orchestrator.js");
    return MemoryOrchestrator.getInstance().runBackground(this.index);
  }

  /**
   * Score recent session summaries against the user message and return up to
   * two relevant snippets. Pure file-system read — no LLM, no embeddings.
   */
  private loadSmartContext(userMessage: string): string {
    try {
      const summaryDir = join(this.dataDir, "memory", "session-summaries");
      if (!existsSync(summaryDir)) return "";
      const summaryFiles = readdirSync(summaryDir).filter((f) => f.endsWith(".md"));
      if (summaryFiles.length === 0) return "";
      const queryWords = userMessage.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
      if (queryWords.length === 0) return "";

      const scored = summaryFiles
        .map((f) => {
          const content = readFileSync(join(summaryDir, f), "utf-8");
          const lower = content.toLowerCase();
          let score = 0;
          for (const w of queryWords) if (lower.includes(w)) score++;
          return { content: content.slice(0, 400), score };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 2);

      if (scored.length === 0) return "";
      return (
        "\n\n--- RELATED PAST SESSIONS ---\n" +
        scored.map((s) => s.content).join("\n---\n") +
        "\n--- END ---"
      );
    } catch (e) {
      logger.warn("loadSmartContext failed:", (e as Error).message);
      return "";
    }
  }
}
