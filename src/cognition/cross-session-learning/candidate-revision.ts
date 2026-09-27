import type { LearnedCandidate, LearnedCandidateState } from "./types.js";

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

export function sameCandidateRevision(candidate: LearnedCandidate, observed: CandidateRevision | undefined): boolean {
  return !!observed && candidate.state === observed.state
    && candidate.updatedAt === observed.updatedAt
    && candidate.transitions.length === observed.transitionCount;
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
