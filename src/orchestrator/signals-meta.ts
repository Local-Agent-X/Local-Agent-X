import { MemoryGraph } from "../memory-graph.js";
import crossSessionLearner, { CrossSessionLearner } from "../cross-session-learning/index.js";
import { UnspokenDetector } from "../unspoken-detector.js";
import { GrowthTracker } from "../growth-tracker.js";
import { MilestoneCelebrator } from "../milestone-celebrations.js";
import { CorrectionLearner } from "../correction-learning.js";
import { ContradictionDetector } from "../contradiction-detector.js";
import type { CognitiveSignal } from "./types.js";
import { CORRECTION_KEYWORDS, FACT_PATTERNS } from "./types.js";

export const metaSignals: CognitiveSignal[] = [
  {
    id: "cross-session-learning",
    scope: "profile",
    triage: ({ msgCount }) => (msgCount % 5 === 0 ? "conditional" : null),
    run: (_input, out) => out.push(...crossSessionLearner.signalsFor()),
    health: () => CrossSessionLearner.getInstance(),
  },

  {
    id: "unspoken-detector",
    storageFile: "unspoken-detector.json",
    scope: "profile",
    triage: ({ msgCount }) => (msgCount % 10 === 0 && msgCount > 0 ? "scheduled" : null),
    run: (_input, out) => out.push(...UnspokenDetector.getInstance().signalsFor()),
    health: () => UnspokenDetector.getInstance(),
  },

  {
    id: "growth-tracker",
    storageFile: "growth-tracker.json",
    scope: "profile",
    triage: ({ msgCount }) => (msgCount % 20 === 0 && msgCount > 0 ? "scheduled" : null),
    run: (_input, out) => out.push(...GrowthTracker.getInstance().signalsFor()),
    health: () => GrowthTracker.getInstance(),
  },

  {
    id: "milestone-celebrations",
    storageFile: "milestones.json",
    scope: "profile",
    triage: ({ msgCount }) =>
      msgCount > 0 && (msgCount % 25 === 0 || msgCount === 1 || msgCount === 10 || msgCount === 50 || msgCount === 100)
        ? "triggered"
        : null,
    run: (_input, out) => out.push(...MilestoneCelebrator.getInstance().signalsFor()),
    health: () => MilestoneCelebrator.getInstance(),
  },

  {
    id: "correction-learning",
    storageFile: "corrections.json",
    scope: "profile",
    critical: true,
    triage: ({ input }) =>
      CORRECTION_KEYWORDS.some(kw => input.message.toLowerCase().includes(kw)) && input.agentPreviousMessage
        ? "triggered"
        : null,
    run(input, _out) {
      // Detection still runs (CorrectionLearner persists records to disk for
      // history/diagnostics), and prepare-request.ts uses the same detector
      // to boost the memory-curate nudge priority. We deliberately STOPPED
      // injecting the verbatim "user corrected X to Y" signal here — that
      // pattern made the system feel like a passive correction logger
      // instead of a learner. Now the model itself decides what to write to
      // USER.md (via memory_update_profile) or the Facts DB (via `remember`)
      // in response to the nudge. Synthesis happens at write time, not at
      // recall time.
      if (!input.agentPreviousMessage) return;
      CorrectionLearner.getInstance().detectCorrection(input.message, input.agentPreviousMessage);
    },
    record(input) {
      if (input.agentPreviousMessage) {
        const cl = CorrectionLearner.getInstance();
        const correction = cl.detectCorrection(input.message, input.agentPreviousMessage);
        if (correction) {
          cl.recordCorrection(correction);
        }
      }
    },
    veto: sig =>
      sig.confidence >= 0.7
        ? {
            reason: "User correction detected — acknowledge and fix",
            overrideSignal: { ...sig, priority: 9, confidence: 1.0 },
          }
        : null,
    health: () => CorrectionLearner.getInstance(),
  },

  {
    id: "contradiction-detector",
    scope: "profile",
    critical: true,
    triage: ({ input }) => (FACT_PATTERNS.some(p => p.test(input.message)) ? "triggered" : null),
    run: (input, out) => out.push(...ContradictionDetector.getInstance().signalsFor(input.message)),
    veto: sig =>
      sig.confidence >= 0.8
        ? {
            reason: "High-confidence contradiction — must address before proceeding",
            overrideSignal: { ...sig, priority: 9, confidence: 1.0 },
          }
        : null,
    health: () => ContradictionDetector.getInstance(),
  },

  {
    id: "memory-graph",
    scope: "profile",
    triage: ({ input }) => (input.message.length > 40 ? "conditional" : null),
    run: (input, out) => out.push(...MemoryGraph.signalsFor(input.message)),
    record: input => MemoryGraph.recordFrom(input.message),
    health: () => MemoryGraph,
  },
];
