import { existsSync, readFileSync } from "node:fs";

import MemoryImportance from "../memory/cognitive/importance/index.js";
import { NarrativeMemory } from "../narrative-memory.js";
import { UnspokenDetector } from "../unspoken-detector.js";
import { GrowthTracker } from "../growth-tracker.js";
import { MemoryTierManager } from "../memory-tiers.js";
import { PredictivePrefetcher } from "../predictive-prefetch.js";
import { MemoryCompressor } from "../memory/cognitive/compression/index.js";
import type { MemoryIndex } from "../memory/index.js";

import type { BackgroundReport } from "./types.js";
import { orchestratorState, safeRun, saveState } from "./state.js";

export function runBackground(memoryIndex?: MemoryIndex): BackgroundReport {
  const startTime = Date.now();

  // Note: consolidation, retain-from-logs, and reflect are scheduled directly
  // via the JobScheduler in src/server/background-jobs.ts. The orchestrator
  // owns the orchestrator-internal jobs only (compression, tiers, prefetch,
  // unspoken, growth, narratives, graph, importance).

  const compression = safeRun("memory-compression:bg", () => {
    const mc = MemoryCompressor.getInstance();
    const report = mc.compressAll(false);
    return { compressed: report.compressed, savedBytes: report.savedTokens };
  }, { compressed: 0, savedBytes: 0 });

  const tierChanges = safeRun("memory-tiers:bg", () => {
    const tm = MemoryTierManager.getInstance();
    const report = tm.reclassifyAll();
    return report.tierCounts;
  }, { hot: 0, warm: 0, cold: 0, archive: 0 });

  const prefetch = safeRun("predictive-prefetch:bg", () => {
    const pp = PredictivePrefetcher.getInstance();
    const now = new Date();
    const result = pp.prefetch(now.getHours(), now.getDay());
    return { topics: result.predictions.map((t: { topic: string }) => t.topic) };
  }, { topics: [] as string[] });

  const unspoken = safeRun("unspoken-detector:bg", () => {
    const ud = UnspokenDetector.getInstance();
    const absences = ud.detectAbsence();
    const changes = ud.detectBehaviorChange();
    return { absences: absences.length, changes: changes.length };
  }, { absences: 0, changes: 0 });

  const growth = safeRun("growth-tracker:bg", () => {
    return GrowthTracker.getInstance().getGrowthSummary();
  }, "");

  const narratives = safeRun("narrative-memory:bg", () => {
    const nm = NarrativeMemory.getInstance();
    return nm.getOngoingStories().length;
  }, 0);

  const graphEdges = safeRun("memory-relations:bg", () => {
    if (!memoryIndex) return 0;
    const before = memoryIndex.relationCount();
    for (let i = 0; i < 7; i++) {
      const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const logPath = memoryIndex.getDailyLogPath(date);
      if (!existsSync(logPath)) continue;
      const content = readFileSync(logPath, "utf-8");
      if (content.length < 20) continue;

      const facts = memoryIndex.recallByTime(
        new Date(date.getTime() - 24 * 60 * 60 * 1000),
        new Date(date.getTime() + 24 * 60 * 60 * 1000),
      );
      const entities = [...new Set(facts.flatMap(f => f.entities))];
      if (entities.length < 2) continue;

      memoryIndex.extractRelations(content, entities);
    }
    return memoryIndex.relationCount() - before;
  }, 0);

  const importanceScored = safeRun("memory-importance:bg", () => {
    if (!memoryIndex) return 0;
    const recentFacts = memoryIndex.recallByTime(
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    );
    let scored = 0;
    for (const fact of recentFacts) {
      MemoryImportance.scoreMemory({
        content: fact.content,
        createdAt: fact.timestamp,
      });
      scored++;
    }
    return scored;
  }, 0);

  orchestratorState.lastBackgroundRun = Date.now();
  saveState(orchestratorState);

  return {
    compression,
    tierChanges,
    prefetch,
    unspoken,
    growth,
    narratives,
    graphEdges,
    importanceScored,
    totalTimeMs: Date.now() - startTime,
  };
}
