// The shapes the learning service hands to its routes, and how a candidate and
// its protocol record project onto them. No store access here: the service
// reads, these functions describe.
import type { LearnedProtocolRecord, LearnedProtocolVersion } from "../../protocols/learned-lifecycle.js";
import { isReviewedProcedureCandidate, type LearnedCandidate, type LearnedCandidateState } from "./types.js";

export interface LearningSummary {
  id: string;
  name: string;
  /** "reviewed": proposed by the post-turn review fork; activates only on the
   *  user's OK or independent evidence, never automatically. */
  source: "observed" | "reviewed";
  state: LearnedCandidateState;
  confidence: number;
  updatedAt: string;
  activeVersionId: string | null;
  versionCount: number;
}

export interface LearningVersionView {
  id: string;
  name: string;
  createdAt: string;
  active: boolean;
  metadata: Record<string, unknown>;
}

export interface LearningDetail extends LearningSummary {
  evidence: LearnedCandidate["evidence"];
  history: LearnedCandidate["transitions"];
  versions: LearningVersionView[];
}

export type LearningAction =
  | { action: "activate"; versionId?: string; expectedActiveVersionId: string | null }
  | { action: "reject" }
  | { action: "archive"; expectedActiveVersionId: string | null }
  | { action: "restore"; expectedActiveVersionId: string | null }
  | { action: "rollback"; versionId: string; expectedActiveVersionId: string | null };

export function learningSummary(candidate: LearnedCandidate, record: LearnedProtocolRecord | null): LearningSummary {
  const latest = record?.versions.at(-1)?.createdAt;
  const effectiveState = record?.state === "active" ? "active"
    : record?.state === "archived" ? "archived"
    : record && !["rejected", "rolled-back"].includes(candidate.state) ? "candidate"
    : candidate.state;
  return {
    id: candidate.id,
    name: candidate.suggestion.name,
    source: isReviewedProcedureCandidate(candidate) ? "reviewed" : "observed",
    state: effectiveState,
    confidence: candidate.confidence,
    updatedAt: latest && Date.parse(latest) > candidate.updatedAt ? latest : new Date(candidate.updatedAt).toISOString(),
    activeVersionId: record?.activeVersionId ?? null,
    versionCount: record?.versions.length ?? 0,
  };
}

export function learningVersionView(version: LearnedProtocolVersion, index: number, record: LearnedProtocolRecord): LearningVersionView {
  return {
    id: version.id,
    name: `Version ${index + 1}`,
    createdAt: version.createdAt,
    active: version.id === record.activeVersionId,
    metadata: structuredClone(version.metadata),
  };
}
