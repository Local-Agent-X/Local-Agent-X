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
import { createFactsTools } from "./tools/facts.js";
import { createForgetTool } from "./tools/forget.js";
import { createProcessTools } from "./tools/process.js";
import { createIngestTool } from "./tools/ingest.js";
import { createDiscoverTool } from "./tools/discover.js";
import { createForgetImportsTool } from "./tools/forget-imports.js";

export function createMemoryTools(memory: MemoryIndex) {
  const search = createSearchTools(memory);
  const save = createSaveTools(memory);
  const facts = createFactsTools(memory);
  const forget = createForgetTool(memory);
  const process = createProcessTools(memory);
  const ingest = createIngestTool(memory);
  const discover = createDiscoverTool(memory);
  const forgetImports = createForgetImportsTool(memory);

  // Index by name so adding/removing tools in createSaveTools etc. doesn't
  // silently misalign with positional array lookups. Look up by name; missing
  // names throw at startup so the bug surfaces immediately.
  const byName = <T extends { name: string }>(arr: T[], name: string): T => {
    const t = arr.find((x) => x.name === name);
    if (!t) throw new Error(`memory tool registry: missing tool '${name}'`);
    return t;
  };

  return [
    byName(search, "memory_search"),
    byName(search, "memory_reindex"),
    byName(search, "memory_get"),
    byName(save, "memory_save"),
    byName(facts, "remember"),
    byName(facts, "update_fact"),
    byName(facts, "forget"),
    byName(search, "memory_recall"),
    byName(process, "memory_reflect"),
    byName(search, "memory_stats"),
    forget,
    byName(save, "memory_set_user_field"),
    byName(save, "memory_update_profile"),
    ingest,
    discover,
    forgetImports,
    byName(process, "memory_consolidate"),
  ];
}
