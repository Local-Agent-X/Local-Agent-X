/**
 * Memory tools exposed to the agent loop.
 *
 * memory_search, memory_save, memory_forget, memory_recall, memory_stats,
 * memory_update_profile, memory_ingest, memory_consolidate — everything the
 * agent can call to read/write persistent memory.
 */
import type { MemoryIndex } from "../memory.js";
import { createSearchTools } from "./tools/search.js";
import { createSaveTools } from "./tools/save.js";
import { createForgetTool } from "./tools/forget.js";
import { createProcessTools } from "./tools/process.js";
import { createIngestTool } from "./tools/ingest.js";

export function createMemoryTools(memory: MemoryIndex) {
  const search = createSearchTools(memory);
  const save = createSaveTools(memory);
  const forget = createForgetTool(memory);
  const process = createProcessTools(memory);
  const ingest = createIngestTool(memory);
  return [
    search[0],   // memory_search
    search[1],   // memory_reindex
    search[2],   // memory_get
    save[0],     // memory_save
    search[3],   // memory_recall
    process[0],  // memory_reflect
    search[4],   // memory_stats
    forget,      // memory_forget
    save[1],     // memory_update_profile
    ingest,      // memory_ingest
    process[1],  // memory_consolidate
  ];
}
