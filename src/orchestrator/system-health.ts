import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { EmotionalMemory } from "../emotional-memory.js";
import { MemoryGraph } from "../memory-graph.js";
import { ProactiveMemory } from "../proactive-memory/index.js";
import MemoryImportance from "../memory-importance/index.js";
import { CrossSessionLearner as CrossSessionLearnerClass } from "../cross-session-learning/index.js";
import { NarrativeMemory } from "../narrative-memory.js";
import { UnspokenDetector } from "../unspoken-detector.js";
import { InsideReferences } from "../inside-references.js";
import { GrowthTracker } from "../growth-tracker.js";
import { AnticipatoryCare } from "../anticipatory-care/index.js";
import { SharedHistory } from "../shared-history.js";
import { LanguageMirror } from "../language-mirror.js";
import { TrustEngine } from "../trust-deepening.js";
import { MilestoneCelebrator } from "../milestone-celebrations.js";
import { VulnerabilityAwareness } from "../vulnerability-awareness.js";
import { CorrectionLearner } from "../correction-learning.js";
import { MemoryTierManager } from "../memory-tiers.js";
import { ContradictionDetector } from "../contradiction-detector.js";
import { AssociativeMemory } from "../associative-recall/index.js";
import { PredictivePrefetcher } from "../predictive-prefetch.js";
import { MemoryCompressor } from "../memory-compression/index.js";
import { MemoryConsolidator } from "../memory-consolidation/index.js";

import type { HealthReport } from "./types.js";
import { LAX_DIR } from "./types.js";
import { orchestratorState } from "./state.js";

export function getSystemHealth(): HealthReport {
  const modulesLoaded: string[] = [];
  const storageSizes: Record<string, number> = {};

  const moduleChecks: [string, () => unknown][] = [
    ["emotional-memory", () => EmotionalMemory],
    ["memory-graph", () => MemoryGraph],
    ["proactive-memory", () => ProactiveMemory],
    ["memory-importance", () => MemoryImportance],
    ["cross-session-learning", () => CrossSessionLearnerClass.getInstance()],
    ["narrative-memory", () => NarrativeMemory.getInstance()],
    ["unspoken-detector", () => UnspokenDetector.getInstance()],
    ["inside-references", () => InsideReferences.getInstance()],
    ["growth-tracker", () => GrowthTracker.getInstance()],
    ["anticipatory-care", () => AnticipatoryCare.getInstance()],
    ["shared-history", () => SharedHistory.getInstance()],
    ["language-mirror", () => LanguageMirror.getInstance()],
    ["trust-engine", () => TrustEngine.getInstance()],
    ["milestone-celebrations", () => MilestoneCelebrator.getInstance()],
    ["vulnerability-awareness", () => VulnerabilityAwareness.getInstance()],
    ["correction-learning", () => CorrectionLearner.getInstance()],
    ["memory-tiers", () => MemoryTierManager.getInstance()],
    ["contradiction-detector", () => ContradictionDetector.getInstance()],
    ["associative-recall", () => AssociativeMemory.getInstance()],
    ["predictive-prefetch", () => PredictivePrefetcher.getInstance()],
    ["memory-compression", () => MemoryCompressor.getInstance()],
    ["memory-consolidation", () => MemoryConsolidator.getInstance()],
  ];

  for (const [name, check] of moduleChecks) {
    try {
      check();
      modulesLoaded.push(name);
    } catch { /* module failed to load */ }
  }

  const storageFiles: Record<string, string> = {
    "emotional-memory": "emotional-history.json",
    "language-mirror": "language-style.json",
    "trust-engine": "trust-engine.json",
    "milestones": "milestones.json",
    "vulnerability": "vulnerability-shares.json",
    "corrections": "corrections.json",
    "shared-history": "shared-history.json",
    "inside-references": "inside-references.json",
    "growth-tracker": "growth-tracker.json",
    "narrative-memory": "narratives.json",
    "unspoken-detector": "unspoken-detector.json",
    "orchestrator": "orchestrator-state.json",
  };

  for (const [name, file] of Object.entries(storageFiles)) {
    const path = join(LAX_DIR, file);
    try {
      if (existsSync(path)) {
        const stat = readFileSync(path, "utf-8");
        storageSizes[name] = stat.length;
      }
    } catch { /* skip */ }
  }

  const errorCounts: Record<string, number> = {};
  for (const err of orchestratorState.errorLog) {
    errorCounts[err.module] = (errorCounts[err.module] || 0) + 1;
  }

  return {
    modulesLoaded,
    storageSizes,
    lastRunTimes: { ...orchestratorState.moduleRunTimes },
    errorCounts,
    uptime: Date.now() - (orchestratorState.lastProcessedAt || Date.now()),
  };
}
