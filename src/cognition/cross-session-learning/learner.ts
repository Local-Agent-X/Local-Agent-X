import type {
  ActionEntry,
  LearnedCandidate,
  LearnedCandidateState,
  OutcomeEvidence,
  SessionData,
} from "./types.js";
import {
  CANDIDATE_TRANSITIONS,
  MAX_ACTIONS,
  hasCandidateEvidenceIdentity,
  normalizeLegacyEvidenceIdentities,
  TERMINAL_TELEMETRY_IDENTITY,
} from "./types.js";
import { autoPrune, ensureDir, loadData, mutateData } from "./persistence.js";
import {
  candidateProjectionPath, transitionCandidate, transitionTimestampAtCommit, type CandidateRevision,
} from "./candidate-revision.js";
import { applyReviewedProposal, type ReviewedProposalInput, type ReviewedProposalResult } from "./reviewed-procedures.js";

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

  getCandidates(): LearnedCandidate[] {
    return structuredClone(this.data.candidates.filter(hasCandidateEvidenceIdentity));
  }

  setCandidateState(
    id: string,
    state: LearnedCandidateState,
    reason?: string,
    now = Date.now(),
  ): LearnedCandidate {
    const observed = this.observedCandidateRevision(id);
    if (observed && !CANDIDATE_TRANSITIONS[observed.state].includes(state)) {
      throw new Error(`Invalid learned candidate transition: ${observed.state} -> ${state}`);
    }
    const committed = this.commit((data) => {
      const index = data.candidates.findIndex((candidate) =>
        candidate.id === id && hasCandidateEvidenceIdentity(candidate)
      );
      if (index < 0) throw new Error(`Unknown learned candidate: ${id}`);
      const current = data.candidates[index];
      data.candidates[index] = transitionCandidate(
        current,
        state,
        transitionTimestampAtCommit(current, now, observed),
        reason,
      );
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
    const observed = this.observedCandidateRevision(id);
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
      const transitionNow = transitionTimestampAtCommit(
        current,
        pendingRollback?.timestamp ?? now,
        observed,
      );
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

  /** Record a post-turn review proposal (see reviewed-procedures.ts). */
  recordReviewedProposal(input: ReviewedProposalInput): ReviewedProposalResult {
    const committed = this.commit((data) => applyReviewedProposal(data, input));
    if (!committed) throw new LearningPersistenceUnavailableError();
    return committed.value;
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

  private observedCandidateRevision(id: string): CandidateRevision | undefined {
    const candidate = this.data.candidates.find((entry) =>
      entry.id === id && hasCandidateEvidenceIdentity(entry)
    );
    return candidate && {
      state: candidate.state,
      updatedAt: candidate.updatedAt,
      transitionCount: candidate.transitions.length,
    };
  }
}

export class LearningPersistenceUnavailableError extends Error {
  constructor() {
    super("Cross-session learning persistence unavailable");
    this.name = "LearningPersistenceUnavailableError";
  }
}

