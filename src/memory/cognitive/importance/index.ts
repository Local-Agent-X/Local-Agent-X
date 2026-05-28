/**
 * Local Agent X — Memory Importance Scoring
 *
 * Scores and ranks memories by importance using weighted factors:
 * recency, frequency, user feedback, content richness, emotional weight.
 * Manages archival of low-importance memories.
 */

export type {
  MemoryEntry,
  ImportanceScore,
  ArchiveResult,
} from "./types.js";

export { MemoryImportance } from "./importance.js";

import { MemoryImportance } from "./importance.js";
export default MemoryImportance.getInstance();
