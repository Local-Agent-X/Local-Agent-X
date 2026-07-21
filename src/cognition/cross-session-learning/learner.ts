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
  hasCandidateEvidenceIdentity,
  normalizeLegacyEvidenceIdentities,
  sanitizeLearnedCandidate,
  TERMINAL_TELEMETRY_IDENTITY,
  WORKFLOW_TACTIC_IDENTITY,
} from "./types.js";
import { autoPrune, ensureDir, loadData, mutateData } from "./persistence.js";
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
    const committed = mutateData((data) => {
      normalizeLegacyEvidenceIdentities(data);
      autoPrune(data);
    });
    if (committed) this.data = committed.data;
  }

  static getInstance(): CrossSessionLearner {
    if (!CrossSessionLearner.instance) {
      CrossSessionLearner.instance = new CrossSessionLearner();
    }
    return CrossSessionLearner.instance;
  }

  refresh(): void {
    this.data = loadData();
  }

  recordAction(
    sessionId: string,
    action: { type: string; details: string; timestamp: number }
  ): void {
    this.commit((data) => {
      data.actions.push({
        ...WORKFLOW_TACTIC_IDENTITY,
        sessionId,
        type: action.type,
        details: action.details,
        timestamp: action.timestamp,
      });
      if (data.actions.length > MAX_ACTIONS) {
        data.actions = data.actions.slice(-MAX_ACTIONS);
      }
    });
  }

  /** Record only the structural receipt of a completed operation. Tool names
   *  are safe capability identifiers; arguments and result text are excluded
   *  so learning cannot become a second transcript or sensitive-data store. */
  recordOutcome(evidence: OutcomeEvidence): void {
    const tools = evidence.tools.map((tool) => tool.trim()).filter(Boolean);
    const entry: ActionEntry = {
      ...TERMINAL_TELEMETRY_IDENTITY,
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
    this.commit((data) => {
      const existing = data.actions.findIndex((action) =>
        action.opId === evidence.opId
        && action.evidenceClass === TERMINAL_TELEMETRY_IDENTITY.evidenceClass
        && action.authority === TERMINAL_TELEMETRY_IDENTITY.authority
      );
      if (existing >= 0) data.actions[existing] = entry;
      else data.actions.push(entry);
      if (data.actions.length > MAX_ACTIONS) {
        data.actions = data.actions.slice(-MAX_ACTIONS);
      }
    });
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
    return structuredClone(this.data.candidates.filter(hasCandidateEvidenceIdentity));
  }

  captureCandidate(pattern: DetectedPattern, now = Date.now()): LearnedCandidate | null {
    const suggestion = this.suggestAutomation(pattern);
    if (!suggestion) return null;
    const next = createLearnedCandidate(pattern, suggestion, now);
    const committed = this.commit((data) => {
      const index = data.candidates.findIndex((candidate) =>
        candidate.id === next.id && hasCandidateEvidenceIdentity(candidate)
      );
      if (index < 0) {
        data.candidates.push(next);
        return next.id;
      }
      const current = data.candidates[index];
      if (
        current.state !== "rejected"
        || (current.rejectionCooldownUntil !== undefined && now < current.rejectionCooldownUntil)
      ) return current.id;

      const revived = transitionCandidate(current, "candidate", now, "New evidence after suppression period");
      data.candidates[index] = {
        ...revived,
        confidence: next.confidence,
        suggestion: next.suggestion,
        evidence: next.evidence,
      };
      return current.id;
    });
    if (!committed) return null;
    return structuredClone(this.requireCommittedCandidate(committed.value));
  }

  setCandidateState(
    id: string,
    state: LearnedCandidateState,
    reason?: string,
    now = Date.now(),
  ): LearnedCandidate {
    const committed = this.commit((data) => {
      const index = data.candidates.findIndex((candidate) =>
        candidate.id === id && hasCandidateEvidenceIdentity(candidate)
      );
      if (index < 0) throw new Error(`Unknown learned candidate: ${id}`);
      data.candidates[index] = transitionCandidate(data.candidates[index], state, now, reason);
      return id;
    });
    if (!committed) throw new LearningPersistenceUnavailableError();
    return structuredClone(this.requireCommittedCandidate(id));
  }

  projectCandidateState(
    id: string,
    target: "candidate" | "active" | "archived",
    reason: string,
    now = Date.now(),
    rollback?: { reason: string; timestamp: number },
  ): boolean {
    const committed = this.commit((data) => {
      const index = data.candidates.findIndex((candidate) =>
        candidate.id === id && hasCandidateEvidenceIdentity(candidate)
      );
      if (index < 0) throw new Error(`Unknown learned candidate: ${id}`);
      let current = data.candidates[index];
      const pendingRollback = rollback && !current.transitions.some((entry) =>
        entry.to === "rolled-back"
        && entry.timestamp === rollback.timestamp
        && entry.reason === rollback.reason
      ) ? rollback : undefined;
      const path = candidateProjectionPath(current.state, target, pendingRollback !== undefined);
      const transitionNow = pendingRollback?.timestamp ?? now;
      for (const state of path) {
        const transitionReason = state === "rolled-back" ? pendingRollback?.reason
          : current.state === "rolled-back" && state === "candidate" ? "Rollback retained active workflow"
          : reason;
        current = transitionCandidate(current, state, transitionNow, transitionReason);
      }
      data.candidates[index] = current;
      return path.length > 0;
    });
    if (!committed) throw new LearningPersistenceUnavailableError();
    return committed.value;
  }

  draftCandidate(id: string, opportunity?: LearnedCandidate): LearnedCandidateDraftResult {
    const candidate = this.data.candidates.find((entry) =>
      hasCandidateEvidenceIdentity(entry) && entry.id === id
    );
    if (!candidate) throw new Error(`Unknown learned candidate: ${id}`);
    if (!opportunity) return draftLearnedCandidate(structuredClone(candidate));
    const safeOpportunity = sanitizeLearnedCandidate(opportunity);
    if (
      !safeOpportunity
      || safeOpportunity.id !== candidate.id
      || safeOpportunity.state !== candidate.state
      || safeOpportunity.evidence.occurrences < candidate.evidence.occurrences
      || safeOpportunity.confidence < candidate.confidence
    ) {
      throw new Error(`Invalid learned refinement opportunity: ${id}`);
    }
    return draftLearnedCandidate(safeOpportunity);
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
      const committed = this.commit((data) => {
        const index = data.candidates.findIndex((entry) =>
          entry.id === candidate.id && hasCandidateEvidenceIdentity(entry)
        );
        if (index < 0) return null;
        const current = data.candidates[index];
        if (current.surfaceCooldownUntil && now < current.surfaceCooldownUntil) return null;
        if (
          current.lastSurfacedOccurrences !== undefined
          && pattern.occurrences <= current.lastSurfacedOccurrences
        ) return null;
        data.candidates[index] = {
          ...current,
          lastSurfacedAt: now,
          lastSurfacedOccurrences: pattern.occurrences,
          surfaceCooldownUntil: now + CANDIDATE_SURFACE_COOLDOWN_DAYS * MS_PER_DAY,
        };
        return current.id;
      });
      if (!committed?.value) continue;
      const surfaced = this.requireCommittedCandidate(committed.value);
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

  private commit<T>(mutation: (data: SessionData) => T) {
    const committed = mutateData(mutation);
    if (committed) this.data = committed.data;
    return committed;
  }

  private requireCommittedCandidate(id: string): LearnedCandidate {
    const candidate = this.data.candidates.find((entry) =>
      entry.id === id && hasCandidateEvidenceIdentity(entry)
    );
    if (!candidate) throw new Error(`Committed learned candidate is missing: ${id}`);
    return candidate;
  }
}

export class LearningPersistenceUnavailableError extends Error {
  constructor() {
    super("Cross-session learning persistence unavailable");
    this.name = "LearningPersistenceUnavailableError";
  }
}

function candidateProjectionPath(
  from: LearnedCandidateState,
  target: "candidate" | "active" | "archived",
  recordRollback: boolean,
): LearnedCandidateState[] {
  if (target === "active") {
    if (recordRollback && from === "active") return ["rolled-back", "candidate", "approved", "active"];
    if (from === "active") return [];
    if (from === "approved") return ["active"];
    if (from === "candidate") return ["approved", "active"];
    return ["candidate", "approved", "active"];
  }
  if (target === "archived") return from === "archived" ? [] : ["archived"];
  if (from === "active") return ["rolled-back", "candidate"];
  if (from === "approved") throw new Error("Approved learned workflow requires activation recovery");
  return from === "candidate" ? [] : ["candidate"];
}
