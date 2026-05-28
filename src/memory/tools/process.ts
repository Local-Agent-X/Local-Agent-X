import type { MemoryIndex } from "../../memory/index.js";

export function createProcessTools(memory: MemoryIndex) {
  return [
    {
      name: "memory_reflect",
      description:
        "Trigger a reflection cycle: updates entity summary pages and opinion confidence scores based on recent facts. Call periodically or when asked to 'reflect' or 'update what you know'.",
      parameters: {
        type: "object",
        properties: {
          since_days: {
            type: "number",
            description: "How many days back to consider (default 7)",
          },
        },
      },
      async execute(args: Record<string, unknown>) {
        const sinceDays = (args.since_days as number) || 7;
        const result = await memory.reflect(sinceDays);
        return {
          content: `Reflection complete. Updated ${result.entitiesUpdated.length} entity pages (${result.entitiesUpdated.join(", ") || "none"}), ${result.opinionsUpdated} opinions.`,
        };
      },
    },

    {
      name: "memory_consolidate",
      description:
        "Extract durable facts from recent conversation chunks. " +
        "Asks an LLM to pull preferences, decisions, plans, and world facts, " +
        "then writes them through the resolver so duplicates are skipped and contradictions update " +
        "existing facts via bi-temporal invalidation. Safe to run repeatedly. " +
        "Intended for nightly cron — expensive to run ad-hoc unless you just ingested a lot of data.",
      parameters: {
        type: "object",
        properties: {
          lookbackHours: { type: "number", description: "How far back to look in hours (default 24, use 8760 for 1 year)" },
          maxSessions: { type: "number", description: "Max sessions to process (default 20, use 500+ for historical backfills)" },
          maxChunksPerSession: { type: "number", description: "Chunks per session cap (default 50)" },
          dryRun: { type: "boolean", description: "Extract facts but don't write them (default false)" },
          provider: { type: "string", enum: ["ollama", "anthropic", "openai", "auto"], description: "Which LLM to use (default auto)" },
          model: { type: "string", description: "Override default model for the chosen provider" },
        },
      },
      async execute(args: Record<string, unknown>) {
        const { runExtraction } = await import("../../memory-extract.js");
        const result = await runExtraction(memory, {
          lookbackHours: typeof args.lookbackHours === "number" ? args.lookbackHours : undefined,
          maxSessions: typeof args.maxSessions === "number" ? args.maxSessions : undefined,
          maxChunksPerSession: typeof args.maxChunksPerSession === "number" ? args.maxChunksPerSession : undefined,
          dryRun: Boolean(args.dryRun),
          provider: args.provider as "ollama" | "anthropic" | "openai" | "auto" | undefined,
          model: typeof args.model === "string" ? args.model : undefined,
        });
        const elapsed = ((result.finishedAt - result.startedAt) / 1000).toFixed(1);
        const ops = result.operations;
        const lines = [
          `Consolidation ${args.dryRun ? "(dry run) " : ""}complete in ${elapsed}s`,
          `  Lookback: ${result.lookbackHours}h`,
          `  Sessions analyzed: ${result.sessionsAnalyzed}`,
          `  Chunks analyzed: ${result.chunksAnalyzed}`,
          `  Facts extracted: ${result.factsExtracted}`,
          `  Operations: add=${ops.add} update=${ops.update} delete=${ops.delete} noop=${ops.noop}`,
          result.errors.length > 0 ? `  Errors: ${result.errors.length}` : "",
        ].filter(Boolean);
        if (result.decisions.length > 0 && result.decisions.length <= 10) {
          lines.push("", "Decisions:");
          for (const d of result.decisions) {
            const target = d.targetId ? ` → id=${d.targetId}` : "";
            lines.push(`  [${d.op}${target}] ${d.content} (${d.reason})`);
          }
        }
        return { content: lines.join("\n") };
      },
    },
  ];
}
