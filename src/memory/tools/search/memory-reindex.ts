const VALID_SOURCES = ["entity", "daily-log", "mind", "session-summary", "session", "personality"] as const;
type IndexSource = (typeof VALID_SOURCES)[number];

export function memoryReindexTool() {
  return {
    name: "memory_reindex",
    description:
      "Force-reindex memory stores. Run if memory_search seems to be missing recently-written facts, or after a manual edit to a memory file. Returns chunk counts per store. Idempotent — already-indexed content costs nothing to re-check.",
    parameters: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description:
            "One of: all, entity, daily-log, mind, session-summary, session, personality (default: all)",
        },
        force: {
          type: "boolean",
          description:
            "If true, drop existing chunks for the targeted source(s) before reindexing. Re-embeds everything. Default false (cheap content-hash dedup).",
        },
      },
    },
    async execute(args: Record<string, unknown>) {
      const source = args.source ? String(args.source) : "all";
      const force = !!args.force;
      try {
        const { getUniversalIndex } = await import("../../universal-index.js");
        const ui = getUniversalIndex();
        if (!ui) {
          return { content: "BLOCKED: universal-index not initialized.", isError: true };
        }
        if (source === "all") {
          const report = await ui.backfillAll({ force });
          return {
            content: JSON.stringify({ ok: true, ...report }, null, 2),
          };
        } else {
          if (!(VALID_SOURCES as readonly string[]).includes(source)) {
            return { content: `BLOCKED: unknown source "${source}". Valid: ${VALID_SOURCES.join(", ")}, all`, isError: true };
          }
          const added = await ui.reindexStore(source as IndexSource);
          return { content: JSON.stringify({ ok: true, source, chunksAdded: added }, null, 2) };
        }
      } catch (e) {
        return { content: `Reindex failed: ${(e as Error).message}`, isError: true };
      }
    },
  };
}
