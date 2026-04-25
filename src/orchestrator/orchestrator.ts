import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { EmotionalMemory } from "../emotional-memory.js";
import { MemoryGraph } from "../memory-graph.js";
import { ProactiveMemory } from "../proactive-memory.js";
import MemoryImportance from "../memory-importance.js";
import { CrossSessionLearner as CrossSessionLearnerClass } from "../cross-session-learning.js";
import { NarrativeMemory } from "../narrative-memory.js";
import { UnspokenDetector } from "../unspoken-detector.js";
import { InsideReferences } from "../inside-references.js";
import { GrowthTracker } from "../growth-tracker.js";
import { AnticipatoryCare } from "../anticipatory-care.js";
import { SharedHistory } from "../shared-history.js";
import { LanguageMirror } from "../language-mirror.js";
import { TrustEngine } from "../trust-deepening.js";
import { MilestoneCelebrator } from "../milestone-celebrations.js";
import { VulnerabilityAwareness } from "../vulnerability-awareness.js";
import { CorrectionLearner } from "../correction-learning.js";
import { MemoryTierManager } from "../memory-tiers.js";
import { ContradictionDetector } from "../contradiction-detector.js";
import { AssociativeMemory } from "../associative-recall.js";
import { PredictivePrefetcher } from "../predictive-prefetch.js";
import { MemoryCompressor } from "../memory-compression.js";
import { MemoryConsolidator } from "../memory-consolidation.js";
import type { MemoryIndex } from "../memory.js";

import type {
  OrchestratorInput,
  OrchestratorOutput,
  DebugInfo,
  BackgroundReport,
  HealthReport,
} from "./types.js";
import { LAX_DIR } from "./types.js";
import { orchestratorState, safeRun } from "./state.js";
import { saveState } from "./state.js";
import { saveExample, autoRateLastExample } from "./storage.js";
import { triageModules } from "./triage.js";
import { gatherSignals } from "./modules.js";
import { applyVetoLayer, calculateFusionConfidence, checkDeepPassNeeded } from "./fusion.js";
import { mergeSignals } from "./signals.js";
import { extractNotifications, recordFromMessage } from "./notifications.js";
import { buildAdaptations } from "./adaptations.js";

export class MemoryOrchestrator {
  private static instance: MemoryOrchestrator;

  private constructor() {}

  static getInstance(): MemoryOrchestrator {
    if (!MemoryOrchestrator.instance) {
      MemoryOrchestrator.instance = new MemoryOrchestrator();
    }
    return MemoryOrchestrator.instance;
  }

  processMessage(input: OrchestratorInput): OrchestratorOutput {
    const startTime = Date.now();
    orchestratorState.messageCount++;

    safeRun("auto-rate", () => autoRateLastExample(input.message), undefined);

    const triage = triageModules(input, orchestratorState.messageCount);
    const allActivated = [...triage.always, ...triage.conditional, ...triage.scheduled, ...triage.triggered];

    let signals = gatherSignals(input, triage);

    const veto = applyVetoLayer(signals);
    if (veto.vetoed && veto.overrideSignal) {
      signals = signals.filter(s => s.source !== veto.overrideSignal!.source);
      signals.unshift(veto.overrideSignal);
    }

    const deepPass = checkDeepPassNeeded(signals, allActivated);
    if (deepPass.needed) {
      for (const mod of deepPass.modules) {
        const deepSignal = safeRun(mod + "-deep", () => {
          const expandedInput = { ...input, sessionMessages: input.sessionMessages.slice(-40) };
          return gatherSignals(expandedInput, { always: [mod], conditional: [], scheduled: [], triggered: [] });
        }, []);
        if (deepSignal.length > 0) {
          signals = signals.filter(s => s.source !== mod);
          signals.push(...deepSignal);
        }
      }
    }

    const merged = mergeSignals(signals, orchestratorState.lastSignalHashes);

    const fusionConfidence = calculateFusionConfidence(merged.usedSignals);

    const notifications = extractNotifications(signals, input);

    const adaptations = buildAdaptations(signals);

    const debug: DebugInfo = {
      modulesActivated: allActivated,
      totalTimeMs: Date.now() - startTime,
      signals: Object.fromEntries(signals.map(s => [s.source + ":" + s.category, {
        signal: s.signal.slice(0, 80),
        priority: s.priority,
        confidence: s.confidence,
      }])),
      fusionConfidence,
      vetoApplied: veto.vetoed,
      vetoReason: veto.reason,
      deepPassTriggered: deepPass.needed,
      deepPassModules: deepPass.modules,
    } as any;

    const output: OrchestratorOutput = {
      contextInjection: merged.paragraph,
      adaptations,
      notifications,
      debug,
    };

    safeRun("recording", () => recordFromMessage(input), undefined);

    safeRun("save-example", () => {
      saveExample({
        input: { message: input.message.slice(0, 200), timeOfDay: input.timeOfDay },
        modulesActivated: allActivated,
        signals: merged.usedSignals.map(s => ({ ...s, signal: s.signal.slice(0, 100) })),
        output: merged.paragraph.slice(0, 300),
        quality: "neutral",
        timestamp: Date.now(),
      });
    }, undefined);

    orchestratorState.lastProcessedAt = Date.now();
    orchestratorState.lastSignalHashes = merged.hashes;
    saveState(orchestratorState);

    return output;
  }

  runBackground(memoryIndex?: MemoryIndex): BackgroundReport {
    const startTime = Date.now();

    const consolidation = safeRun("memory-consolidation:bg", () => {
      const mc = MemoryConsolidator.getInstance();
      const report = mc.consolidate();
      return { merged: report.mergedCount, promoted: report.promotedCount };
    }, { merged: 0, promoted: 0 });

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

    const retained = safeRun("retain-from-logs:bg", () => {
      if (!memoryIndex) return 0;
      let totalRetained = 0;
      for (let i = 0; i < 7; i++) {
        const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
        const facts = memoryIndex.retainFromDailyLog(date);
        totalRetained += facts.length;
      }
      return totalRetained;
    }, 0);

    const reflected = safeRun("reflect:bg", () => {
      if (!memoryIndex) return { entitiesUpdated: 0, opinionsUpdated: 0 };
      let result = { entitiesUpdated: 0, opinionsUpdated: 0 };
      memoryIndex.reflect(7).then(r => {
        result = { entitiesUpdated: r.entitiesUpdated.length, opinionsUpdated: r.opinionsUpdated };
      }).catch(() => {});
      return result;
    }, { entitiesUpdated: 0, opinionsUpdated: 0 });

    const graphEdges = safeRun("memory-graph:bg", () => {
      if (!memoryIndex) return 0;
      let edgesAdded = 0;
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

        const extracted = MemoryGraph.autoExtractRelationships(content, entities);
        for (const edge of extracted) {
          MemoryGraph.addEdge(edge.from, edge.relation, edge.to, edge.metadata);
          edgesAdded++;
        }
      }
      return edgesAdded;
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
      consolidation,
      compression,
      tierChanges,
      prefetch,
      unspoken,
      growth,
      narratives,
      retained,
      reflected,
      graphEdges,
      importanceScored,
      totalTimeMs: Date.now() - startTime,
    };
  }

  getSystemHealth(): HealthReport {
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
}
