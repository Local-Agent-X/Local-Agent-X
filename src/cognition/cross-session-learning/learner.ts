import type {
  ActionEntry,
  AutomationSuggestion,
  DetectedPattern,
  LearnedCandidate,
  LearnedCandidateState,
  OutcomeEvidence,
  SessionData,
  SessionInsight,
} from "./types.js";
import {
  DEFAULT_MIN_OCCURRENCES,
  CANDIDATE_SURFACE_COOLDOWN_DAYS,
  MAX_ACTIONS,
  MS_PER_DAY,
  PRUNE_AGE_DAYS,
} from "./types.js";
import { autoPrune, ensureDir, loadData, persistData } from "./persistence.js";
import {
  detectRepeatedQuestions,
  detectRepeatedTasks,
  detectRepeatedTopics,
  detectTimePatterns,
  detectWorkflowPatterns,
} from "./detectors.js";
import {
  createLearnedCandidate,
  getInsights,
  suggestAutomation,
  transitionCandidate,
} from "./suggestions.js";
import { fuzzyMatch } from "./text-utils.js";
import type { ModuleSignal } from "../../orchestrator/types.js";
import { formatLearningCandidateNudge } from "../../memory/curate-nudge.js";
import { draftLearnedCandidate, type LearnedCandidateDraftResult } from "../../protocols/learned-drafting.js";

export class CrossSessionLearner {
  private static instance: CrossSessionLearner;
  private data: SessionData;

  private constructor() {
    ensureDir();
    this.data = loadData();
    if (autoPrune(this.data)) {
      persistData(this.data);
    }
  }

  static getInstance(): CrossSessionLearner {
    if (!CrossSessionLearner.instance) {
      CrossSessionLearner.instance = new CrossSessionLearner();
    }
    return CrossSessionLearner.instance;
  }

  recordAction(
    sessionId: string,
    action: { type: string; details: string; timestamp: number }
  ): void {
    this.data.actions.push({
      sessionId,
      type: action.type,
      details: action.details,
      timestamp: action.timestamp,
    });

    if (this.data.actions.length > MAX_ACTIONS) {
      this.data.actions = this.data.actions.slice(
        this.data.actions.length - MAX_ACTIONS
      );
    }

    persistData(this.data);
  }

  /** Record only the structural receipt of a completed operation. Tool names
   *  are safe capability identifiers; arguments and result text are excluded
   *  so learning cannot become a second transcript or sensitive-data store. */
  recordOutcome(evidence: OutcomeEvidence): void {
    const tools = evidence.tools.map((tool) => tool.trim()).filter(Boolean);
    const entry: ActionEntry = {
      opId: evidence.opId,
      sessionId: evidence.sessionId,
      type: "op_outcome",
      details: `${evidence.category}:${tools.join(" -> ") || "no-tools"}`,
      timestamp: evidence.timestamp,
      outcome: evidence.outcome,
      category: evidence.category,
      tools,
      ...(evidence.model ? { model: evidence.model } : {}),
    };
    const existing = this.data.actions.findIndex((action) => action.opId === evidence.opId);
    if (existing >= 0) this.data.actions[existing] = entry;
    else this.data.actions.push(entry);
    if (this.data.actions.length > MAX_ACTIONS) {
      this.data.actions = this.data.actions.slice(-MAX_ACTIONS);
    }
    persistData(this.data);
  }

  detectPatterns(minOccurrences?: number): DetectedPattern[] {
    const min = minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
    const actions: ActionEntry[] = this.data.actions;
    const patterns: DetectedPattern[] = [];

    patterns.push(...detectRepeatedQuestions(actions, min));
    patterns.push(...detectRepeatedTasks(actions, min));
    patterns.push(...detectRepeatedTopics(actions, Math.max(min, 5)));
    patterns.push(...detectTimePatterns(actions, min));
    patterns.push(...detectWorkflowPatterns(actions, min));

    return patterns.sort((a, b) => b.occurrences - a.occurrences);
  }

  suggestAutomation(pattern: DetectedPattern): AutomationSuggestion | null {
    if (pattern.automationEligible === false) return null;
    return suggestAutomation(pattern);
  }

  getCandidates(): LearnedCandidate[] {
    return structuredClone(this.data.candidates);
  }

  captureCandidate(pattern: DetectedPattern, now = Date.now()): LearnedCandidate | null {
    const suggestion = this.suggestAutomation(pattern);
    if (!suggestion) return null;
    const next = createLearnedCandidate(pattern, suggestion, now);
    const index = this.data.candidates.findIndex((candidate) => candidate.id === next.id);
    if (index < 0) {
      this.data.candidates.push(next);
      persistData(this.data);
      return structuredClone(next);
    }

    const current = this.data.candidates[index];
    if (
      current.state === "rejected"
      && current.rejectionCooldownUntil !== undefined
      && now < current.rejectionCooldownUntil
    ) {
      return structuredClone(current);
    }
    if (current.state !== "rejected") return structuredClone(current);

    const revived = transitionCandidate(current, "candidate", now, "New evidence after suppression period");
    this.data.candidates[index] = {
      ...revived,
      confidence: next.confidence,
      suggestion: next.suggestion,
      evidence: next.evidence,
    };
    persistData(this.data);
    return structuredClone(this.data.candidates[index]);
  }

  setCandidateState(
    id: string,
    state: LearnedCandidateState,
    reason?: string,
    now = Date.now(),
  ): LearnedCandidate {
    const index = this.data.candidates.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new Error(`Unknown learned candidate: ${id}`);
    const updated = transitionCandidate(this.data.candidates[index], state, now, reason);
    this.data.candidates[index] = updated;
    persistData(this.data);
    return structuredClone(updated);
  }

  draftCandidate(id: string, opportunity?: LearnedCandidate): LearnedCandidateDraftResult {
    const candidate = this.data.candidates.find((entry) => entry.id === id);
    if (!candidate) throw new Error(`Unknown learned candidate: ${id}`);
    if (!opportunity) return draftLearnedCandidate(structuredClone(candidate));
    if (
      opportunity.id !== candidate.id
      || opportunity.state !== candidate.state
      || opportunity.evidence.occurrences < candidate.evidence.occurrences
      || opportunity.confidence < candidate.confidence
    ) {
      throw new Error(`Invalid learned refinement opportunity: ${id}`);
    }
    return draftLearnedCandidate(structuredClone(opportunity));
  }

  getInsights(): SessionInsight[] {
    return getInsights(this.data.actions);
  }

  fuzzyMatch(a: string, b: string): number {
    return fuzzyMatch(a, b);
  }

  nextLearningOpportunity(now = Date.now()): { candidate: LearnedCandidate; draftCandidate: LearnedCandidate } | null {
    const patterns = this.detectPatterns(3);
    const staleCutoff = now - PRUNE_AGE_DAYS * MS_PER_DAY;
    for (const pattern of patterns) {
      if (
        pattern.lastSeen <= staleCutoff
        || pattern.type !== "workflow"
        || pattern.automationEligible !== true
      ) continue;
      const candidate = this.captureCandidate(pattern, now);
      const suggestion = this.suggestAutomation(pattern);
      if (!candidate || !suggestion || !["candidate", "active"].includes(candidate.state)) continue;
      const live = createLearnedCandidate(pattern, suggestion, now);
      if (live.confidence < 0.75) continue;
      if (candidate.surfaceCooldownUntil && now < candidate.surfaceCooldownUntil) continue;
      if (
        candidate.lastSurfacedOccurrences !== undefined
        && pattern.occurrences <= candidate.lastSurfacedOccurrences
      ) continue;

      const index = this.data.candidates.findIndex((entry) => entry.id === candidate.id);
      const surfaced = {
        ...this.data.candidates[index],
        lastSurfacedAt: now,
        lastSurfacedOccurrences: pattern.occurrences,
        surfaceCooldownUntil: now + CANDIDATE_SURFACE_COOLDOWN_DAYS * MS_PER_DAY,
      };
      this.data.candidates[index] = surfaced;
      persistData(this.data);
      const draftCandidate: LearnedCandidate = {
        ...live,
        state: surfaced.state,
        createdAt: surfaced.createdAt,
        transitions: structuredClone(surfaced.transitions),
      };
      return { candidate: structuredClone(surfaced), draftCandidate };
    }
    return null;
  }

  nextLearningCandidate(now = Date.now()): LearnedCandidate | null {
    return this.nextLearningOpportunity(now)?.candidate ?? null;
  }

  /** Quiet, deduplicated learning signal for the orchestrator prompt path. */
  signalsFor(mode: "assisted" | "autonomous" = "assisted", now = Date.now()): ModuleSignal[] {
    const opportunity = this.nextLearningOpportunity(now);
    return opportunity ? [formatLearningCandidateNudge(opportunity.draftCandidate, mode)] : [];
  }
}
