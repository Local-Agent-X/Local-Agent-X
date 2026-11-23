import type { LearnedCandidate, LearnedCandidateState } from "./types.js";
import { CANDIDATE_TRANSITIONS, hasCandidateEvidenceIdentity, REJECTION_COOLDOWN_DAYS } from "./types.js";
import { MS_PER_DAY } from "../../util/time.js";

export interface CandidateRevision {
  state: LearnedCandidateState;
  updatedAt: number;
  transitionCount: number;
}

export function transitionTimestampAtCommit(
  current: LearnedCandidate,
  requestedAt: number,
  observed: CandidateRevision | undefined,
): number {
  if (!observed || requestedAt < observed.updatedAt) return requestedAt;
  return Math.max(requestedAt, current.updatedAt);
}

export function candidateProjectionPath(
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

/** One legal state change, recorded in the candidate's transition history. */
export function transitionCandidate(
  candidate: LearnedCandidate,
  to: LearnedCandidateState,
  now = Date.now(),
  reason?: string,
): LearnedCandidate {
  if (!hasCandidateEvidenceIdentity(candidate)) {
    throw new Error("Learned candidate has mismatched evidence authority");
  }
  if (now < candidate.updatedAt) {
    throw new Error(`Learned candidate transition predates current state: ${candidate.id}`);
  }
  if (!CANDIDATE_TRANSITIONS[candidate.state].includes(to)) {
    throw new Error(`Invalid learned candidate transition: ${candidate.state} -> ${to}`);
  }
  const { rejectionCooldownUntil: _cooldown, ...base } = candidate;
  return {
    ...base,
    state: to,
    updatedAt: now,
    ...(to === "rejected"
      ? { rejectionCooldownUntil: now + REJECTION_COOLDOWN_DAYS * MS_PER_DAY }
      : {}),
    transitions: [
      ...candidate.transitions,
      { from: candidate.state, to, timestamp: now, ...(reason ? { reason } : {}) },
    ],
  };
}
