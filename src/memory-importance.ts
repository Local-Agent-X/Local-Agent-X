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
} from "./memory-importance/types.js";

export { MemoryImportance } from "./memory-importance/importance.js";

import { MemoryImportance } from "./memory-importance/importance.js";
export default MemoryImportance.getInstance();
