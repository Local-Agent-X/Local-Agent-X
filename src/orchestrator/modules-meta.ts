import { MemoryGraph } from "../memory-graph.js";
import crossSessionLearner from "../cross-session-learning.js";
import { UnspokenDetector } from "../unspoken-detector.js";
import { GrowthTracker } from "../growth-tracker.js";
import { SharedHistory } from "../shared-history.js";
import { MilestoneCelebrator } from "../milestone-celebrations.js";
import { CorrectionLearner } from "../correction-learning.js";
import { ContradictionDetector } from "../contradiction-detector.js";
import { getUniversalIndex } from "../memory/universal-index.js";
import type { OrchestratorInput, ModuleSignal } from "./types.js";
import { GRAPH_STOP_WORDS } from "./types.js";

export function runMetaModule(name: string, input: OrchestratorInput, signals: ModuleSignal[]): boolean {
  switch (name) {
    case "cross-session-learning": {
      const csl = crossSessionLearner;
      const patterns = csl.detectPatterns(3);
      if (patterns.length > 0) {
        const top = patterns[0];
        signals.push({
          source: "cross-session-learning",
          signal: `Recurring pattern: ${top.description} (seen ${top.occurrences}x)`,
          priority: 3,
          category: "pattern",
          confidence: 1.0,
        });
      }
      return true;
    }

    case "unspoken-detector": {
      const ud = UnspokenDetector.getInstance();
      const absences = ud.detectAbsence();
      if (absences.length > 0) {
        const hint = ud.getSensitivityHint(absences);
        if (hint) {
          signals.push({
            source: "unspoken-detector",
            signal: hint,
            priority: 6,
            category: "unspoken",
            confidence: 1.0,
          });
        }
      }
      const changes = ud.detectBehaviorChange();
      if (changes.length > 0) {
        signals.push({
          source: "unspoken-detector",
          signal: `Behavior change: ${changes[0].description}`,
          priority: 5,
          category: "behavior-change",
          confidence: 1.0,
        });
      }
      return true;
    }

    case "growth-tracker": {
      const gt = GrowthTracker.getInstance();
      const summary = gt.getGrowthSummary();
      if (summary && summary.length > 10) {
        signals.push({
          source: "growth-tracker",
          signal: summary,
          priority: 3,
          category: "growth",
          confidence: 1.0,
        });
      }
      return true;
    }

    case "milestone-celebrations": {
      const mc = MilestoneCelebrator.getInstance();
      const sh = SharedHistory.getInstance();
      const summary = sh.getRelationshipSummary();
      const context = {
        conversationCount: summary.totalConversations || 0,
        appCount: summary.totalApps || 0,
        daysTogether: summary.daysTogether || 0,
        toolsUsed: [] as string[],
        streak: 0,
      };
      const milestones = mc.checkMilestones(context);
      for (const m of milestones) {
        const celebration = mc.celebrate(m);
        signals.push({
          source: "milestone-celebrations",
          signal: celebration,
          priority: 8,
          category: "milestone",
          confidence: 1.0,
        });
      }
      return true;
    }

    case "correction-learning": {
      // Detection still runs (CorrectionLearner persists records to disk for
      // history/diagnostics), and prepare-request.ts uses the same detector
      // to boost the memory-curate nudge priority. We deliberately STOPPED
      // injecting the verbatim "user corrected X to Y" signal here — that
      // pattern made the system feel like a passive correction logger
      // instead of a learner. Now the model itself decides what to write to
      // USER.md (via memory_update_profile) or the Facts DB (via `remember`)
      // in response to the nudge. Synthesis happens at write time, not at
      // recall time.
      if (!input.agentPreviousMessage) return true;
      const cl = CorrectionLearner.getInstance();
      cl.detectCorrection(input.message, input.agentPreviousMessage);
      return true;
    }

    case "contradiction-detector": {
      // Pre-fix this read from cd.getContradictionHistory() — its own
      // log of past contradictions. The auto-recording path was
      // unreliable, so the comparison set was almost always empty and
      // the detector never fired. Now we pull live facts from the Facts
      // DB so the detector actually sees the user's accumulated
      // preferences when they say "stop X" / "don't do X anymore".
      const cd = ContradictionDetector.getInstance();
      let factTexts: string[] = [];
      try {
        const ui = getUniversalIndex();
        const memory = ui?.getMemory();
        if (memory) {
          factTexts = memory
            .recallRecentFacts({ limit: 100, minConfidence: 0.4 })
            .map(f => f.content);
        }
      } catch { /* facts unavailable — fall through to no-op */ }
      if (factTexts.length > 0) {
        const contradiction = cd.checkContradiction(input.message, factTexts);
        if (contradiction) {
          signals.push({
            source: "contradiction-detector",
            signal:
              `Possible contradiction with prior fact: "${contradiction.oldFact}" — ` +
              `user just said "${contradiction.newFact}". Call \`forget\` or \`update_fact\` ` +
              `to retire the stale fact, don't just save a new one alongside it.`,
            priority: 9,
            category: "contradiction",
            confidence: 0.8,
          });
        }
      }
      return true;
    }

    case "memory-graph": {
      const entityCandidates = [...new Set(
        (input.message.match(/\b[A-Z][a-zA-Z]{2,}\b/g) || [])
          .filter(w => !GRAPH_STOP_WORDS.has(w.toLowerCase()))
      )];
      if (entityCandidates.length > 0) {
        const relationships: string[] = [];
        for (const entity of entityCandidates.slice(0, 5)) {
          const edges = MemoryGraph.getEdges(entity, "out");
          for (const edge of edges.slice(0, 3)) {
            relationships.push(`${edge.from} ${edge.relation} ${edge.to}`);
          }
        }
        if (relationships.length > 0) {
          signals.push({
            source: "memory-graph",
            signal: `Known relationships: ${relationships.slice(0, 5).join("; ")}`,
            priority: 3,
            category: "knowledge-graph",
            confidence: 0.6,
          });
        }
      }
      return true;
    }
  }
  return false;
}
