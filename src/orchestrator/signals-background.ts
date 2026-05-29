import MemoryImportance from "../memory/cognitive/importance/index.js";
import { PredictivePrefetcher } from "../predictive-prefetch.js";
import { MemoryTierManager } from "../memory-tiers.js";
import { MemoryCompressor } from "../memory/cognitive/compression/index.js";
import { MemoryConsolidator } from "../memory/cognitive/consolidation/index.js";
import type { CognitiveSignal } from "./types.js";

/**
 * Cognitive modules wired into the orchestrator that learn or maintain state
 * but emit no turn signal — so they declare `record` and/or `health` only,
 * never `run` or `triage`. They live in the registry so the recording loop
 * and the health report stay single-sourced rather than re-listing them.
 */
export const backgroundSignals: CognitiveSignal[] = [
  {
    id: "predictive-prefetch",
    scope: "profile",
    record(input) {
      const words = input.message.toLowerCase().split(/\s+/).filter(w => w.length > 4);
      PredictivePrefetcher.getInstance().learnSchedule(Date.now(), words.slice(0, 10), []);
    },
    health: () => PredictivePrefetcher.getInstance(),
  },

  {
    id: "memory-importance",
    scope: "profile",
    record(input) {
      if (input.message.length > 30) {
        MemoryImportance.scoreMemory({ content: input.message, createdAt: Date.now() });
      }
    },
    health: () => MemoryImportance,
  },

  {
    id: "memory-tiers",
    scope: "profile",
    health: () => MemoryTierManager.getInstance(),
  },

  {
    id: "memory-compression",
    scope: "profile",
    health: () => MemoryCompressor.getInstance(),
  },

  {
    id: "memory-consolidation",
    scope: "profile",
    health: () => MemoryConsolidator.getInstance(),
  },
];
