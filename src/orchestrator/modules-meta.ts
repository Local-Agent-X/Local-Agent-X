import { MemoryGraph } from "../memory-graph.js";
import crossSessionLearner from "../cross-session-learning.js";
import { UnspokenDetector } from "../unspoken-detector.js";
import { GrowthTracker } from "../growth-tracker.js";
import { SharedHistory } from "../shared-history.js";
import { MilestoneCelebrator } from "../milestone-celebrations.js";
import { CorrectionLearner } from "../correction-learning.js";
import { ContradictionDetector } from "../contradiction-detector.js";
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
      if (!input.agentPreviousMessage) return true;
      const cl = CorrectionLearner.getInstance();
      const correction = cl.detectCorrection(input.message, input.agentPreviousMessage);
      if (correction) {
        signals.push({
          source: "correction-learning",
          signal: `User is correcting: "${correction.wrongInfo}" should be "${correction.correctInfo}" — avoid repeating this mistake`,
          priority: 9,
          category: "correction",
          confidence: 0.9,
        });
        const context = cl.getCorrectiveContext(correction.wrongInfo);
        if (context) {
          signals.push({
            source: "correction-learning",
            signal: context,
            priority: 8,
            category: "correction-context",
            confidence: 0.8,
          });
        }
      }
      return true;
    }

    case "contradiction-detector": {
      const cd = ContradictionDetector.getInstance();
      const history = cd.getContradictionHistory();
      const existingFacts = history.map(r => r.contradiction.oldFact);
      if (existingFacts.length > 0) {
        const contradiction = cd.checkContradiction(input.message, existingFacts);
        if (contradiction) {
          signals.push({
            source: "contradiction-detector",
            signal: `Possible contradiction: "${contradiction.oldFact}" vs "${contradiction.newFact}" — gently clarify`,
            priority: 7,
            category: "contradiction",
            confidence: 0.7,
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
