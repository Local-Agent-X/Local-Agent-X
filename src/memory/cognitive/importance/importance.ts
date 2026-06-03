import type { ImportanceScore } from "./types.js";
import { scoreMemory } from "./scoring.js";

/**
 * Importance scoring facade. Wraps the pure scoreMemory() behind a stable
 * singleton entry point used by the background orchestrator signals.
 *
 * The earlier file-based archive/decay store (memory-scores.json,
 * memory-archive/, autoArchive/getArchiveCandidates/recordAccess/...) was never
 * read by any live path — the real memory store is the SQLite facts DB — so it
 * was removed. Scoring is now a pure function of the passed memory.
 */
export class MemoryImportance {
  private static instance: MemoryImportance;

  static getInstance(): MemoryImportance {
    if (!MemoryImportance.instance) {
      MemoryImportance.instance = new MemoryImportance();
    }
    return MemoryImportance.instance;
  }

  scoreMemory(memory: {
    content: string;
    createdAt: number;
    lastAccessed?: number;
    accessCount?: number;
    userFeedback?: "positive" | "negative";
  }): ImportanceScore {
    return scoreMemory(memory);
  }
}
