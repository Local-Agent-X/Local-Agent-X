import type { MemoryIndex } from "../../memory.js";
import { memorySearchTool } from "./search/memory-search.js";
import { searchPastSessionsTool } from "./search/search-past-sessions.js";
import { memoryReindexTool } from "./search/memory-reindex.js";
import { memoryGetTool } from "./search/memory-get.js";
import { memoryRecallTool } from "./search/memory-recall.js";
import { memoryStatsTool } from "./search/memory-stats.js";

export function createSearchTools(memory: MemoryIndex) {
  return [
    memorySearchTool(memory),
    searchPastSessionsTool(memory),
    memoryReindexTool(),
    memoryGetTool(memory),
    memoryRecallTool(memory),
    memoryStatsTool(memory),
  ];
}
