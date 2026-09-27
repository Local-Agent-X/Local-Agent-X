import {
  MAX_REVIEWED_PROPOSALS,
  REVIEWED_PROCEDURE_IDENTITY,
  deriveCandidateId,
  hasCandidateEvidenceIdentity,
  isReviewedProcedureCandidate,
  reviewedProcedureDescription,
  type LearnedCandidate,
  type ReviewedProposal,
  type ReviewedProposalOutcome,
  type SessionData,
} from "./types.js";
import { transitionCandidate } from "./suggestions.js";
import { reviewedProcedureConfidence } from "../../protocols/learned-refinement.js";

export interface ReviewedProposalInput {
  /** Procedure name — the candidate's identity. */
  name: string;
  /** One-line catalog description; the newest proposal's wording wins. */
  description: string;
  sessionId: string;
  outcome: ReviewedProposalOutcome;
  timestamp: number;
}

export type ReviewedProposalResult =
  | { ok: true; candidate: LearnedCandidate; created: boolean; revived: boolean }
  | { ok: false; reason: "discarded" | "no-existing-procedure" | "not-reviewed" };

export function reviewedProcedureCandidateId(name: string): string {
  return deriveCandidateId("procedure", reviewedProcedureDescription(name), [name]);
}

function withProposals(
  base: LearnedCandidate,
  proposals: ReviewedProposal[],
  input: ReviewedProposalInput,
): LearnedCandidate {
  return {
    ...base,
    updatedAt: Math.max(base.updatedAt, input.timestamp),
    confidence: reviewedProcedureConfidence(proposals),
    suggestion: {
      ...base.suggestion,
      description: input.description,
      config: { patternType: "procedure", occurrences: proposals.length },
    },
    evidence: {
      ...base.evidence,
      occurrences: proposals.length,
      lastSeen: input.timestamp,
      proposals,
    },
  };
}

function newCandidate(input: ReviewedProposalInput, proposals: ReviewedProposal[]): LearnedCandidate {
  return {
    ...REVIEWED_PROCEDURE_IDENTITY,
    id: reviewedProcedureCandidateId(input.name),
    state: "candidate",
    confidence: reviewedProcedureConfidence(proposals),
    suggestion: {
      type: "mission",
      name: input.name,
      description: input.description,
      config: { patternType: "procedure", occurrences: proposals.length },
    },
    evidence: {
      ...REVIEWED_PROCEDURE_IDENTITY,
      patternType: "procedure",
      description: reviewedProcedureDescription(input.name),
      occurrences: proposals.length,
      lastSeen: input.timestamp,
      examples: [input.name],
      proposals,
    },
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
    transitions: [],
  };
}

/**
 * Record one review-fork proposal against the learning store. Mutates `data`
 * in place (run it inside the store's commit) and never touches the protocol
 * lifecycle — drafting the version is the caller's second step.
 *
 * A proposal from a corrected run may only add to a procedure that already
 * exists: a run the user reverted is never the origin of a new playbook. A
 * procedure the user discarded stays discarded for its rejection cooldown;
 * after it, a fresh proposal revives it with its evidence reset.
 */
export function applyReviewedProposal(data: SessionData, input: ReviewedProposalInput): ReviewedProposalResult {
  const id = reviewedProcedureCandidateId(input.name);
  const proposal: ReviewedProposal = { sessionId: input.sessionId, timestamp: input.timestamp, outcome: input.outcome };
  const index = data.candidates.findIndex((entry) => entry.id === id && hasCandidateEvidenceIdentity(entry));
  let next: LearnedCandidate;
  let created = false;
  let revived = false;
  if (index < 0) {
    if (input.outcome === "corrected") return { ok: false, reason: "no-existing-procedure" };
    next = newCandidate(input, [proposal]);
    created = true;
  } else {
    const current = data.candidates[index];
    if (!isReviewedProcedureCandidate(current)) return { ok: false, reason: "not-reviewed" };
    let base = current;
    let prior = current.evidence.proposals ?? [];
    if (current.state === "rejected") {
      const cooling = current.rejectionCooldownUntil !== undefined && input.timestamp < current.rejectionCooldownUntil;
      if (cooling || input.outcome === "corrected") return { ok: false, reason: "discarded" };
      base = transitionCandidate(current, "candidate", Math.max(input.timestamp, current.updatedAt), "Proposed again after the discard cooldown");
      prior = [];
      revived = true;
    }
    next = withProposals(base, [...prior, proposal].slice(-MAX_REVIEWED_PROPOSALS), input);
  }
  if (!isReviewedProcedureCandidate(next)) throw new Error(`Reviewed procedure proposal is malformed: ${input.name}`);
  if (index < 0) data.candidates.push(next);
  else data.candidates[index] = next;
  return { ok: true, candidate: structuredClone(next), created, revived };
}
