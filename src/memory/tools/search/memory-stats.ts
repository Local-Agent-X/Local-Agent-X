import type { MemoryIndex } from "../../../memory/index.js";

export function memoryStatsTool(memory: MemoryIndex) {
  return {
    name: "memory_stats",
    description: "Get memory system statistics: chunks, files, facts, entities, cache size.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const stats = memory.getStats();
      return {
        content: [
          `Indexed files: ${stats.totalFiles}`,
          `Chunks: ${stats.totalChunks}`,
          `Retained facts: ${stats.totalFacts}`,
          `Known entities: ${stats.totalEntities}`,
          `Embedding cache: ${stats.cacheSize} entries`,
          `FTS5: ${stats.hasFts ? "active" : "unavailable"}`,
          `sqlite-vec: ${stats.hasVec ? "active" : "unavailable (using in-memory cosine)"}`,
        ].join("\n"),
      };
    },
  };
}
