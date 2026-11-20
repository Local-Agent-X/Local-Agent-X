import type { LearnedCandidate, ReviewedProposal } from "../cognition/cross-session-learning/types.js";
import { isReviewedProcedureCandidate } from "../cognition/cross-session-learning/types.js";
import type { LearnedOutcomeReceipt, VersionEffectiveness } from "./learned-effectiveness.js";
import type { LearnedProtocolRecord } from "./learned-lifecycle.js";

/** A reviewed procedure activates without the user's OK once this many
 *  distinct sessions independently proposed it from runs that held up. */
export const REVIEWED_PROCEDURE_MIN_SESSIONS = 3;

/** The user is asked to keep a reviewed procedure only once this many distinct
 *  sessions proposed it. One run is a coincidence; a card for every coincidence
 *  produced 54 drafts and zero keeps on the first machine this shipped on. */
export const REVIEWED_PROCEDURE_NOTICE_SESSIONS = 2;

/** Sessions that count as independent evidence for a reviewed procedure: each
 *  proposed it from a verified run, and none of its proposals reported the
 *  user reverting or correcting the work. */
export function qualifyingReviewedSessions(proposals: readonly ReviewedProposal[]): number {
  const corrected = new Set(proposals.filter((p) => p.outcome === "corrected").map((p) => p.sessionId));
  return new Set(proposals
    .filter((p) => p.outcome === "verified" && !corrected.has(p.sessionId))
    .map((p) => p.sessionId)).size;
}

export function reviewedProcedureConfidence(proposals: readonly ReviewedProposal[]): number {
  return Math.round(Math.min(1, qualifyingReviewedSessions(proposals) / REVIEWED_PROCEDURE_MIN_SESSIONS) * 1000) / 1000;
}

export function hasIndependentReviewedEvidence(candidate: LearnedCandidate): boolean {
  if (!isReviewedProcedureCandidate(candidate)) return false;
  return qualifyingReviewedSessions(candidate.evidence.proposals ?? []) >= REVIEWED_PROCEDURE_MIN_SESSIONS;
}

/** Whether a reviewed procedure has earned the user's attention. A migrated
 *  procedure (an "unverified" proposal) was already in the user's catalog and
 *  is reviewable at once; a review-proposed one waits for a second session. */
export function reviewedProcedureNoticeReady(candidate: LearnedCandidate): boolean {
  if (!isReviewedProcedureCandidate(candidate)) return false;
  const proposals = candidate.evidence.proposals ?? [];
  if (proposals.some((p) => p.outcome === "unverified")) return true;
  return qualifyingReviewedSessions(proposals) >= REVIEWED_PROCEDURE_NOTICE_SESSIONS;
}

/** What the probation monitor decided. `cause` is what the activation history
 *  records, so a safety rollback is known as one by its field, not its wording. */
export type SafetyRecovery =
  | { kind: "rollback"; targetVersionId: string; reason: string; cause: "safety" }
  | { kind: "archive"; reason: string; cause: "safety" };

function windowMetrics(receipts: LearnedOutcomeReceipt[]): { cleanRate: number; quality: number } {
  const clean = receipts.filter((entry) => entry.outcome === "clean").length;
  const partial = receipts.filter((entry) => entry.outcome === "partial").length;
  return { cleanRate: clean / receipts.length, quality: (clean + 0.5 * partial) / receipts.length };
}

function healthyPrior(metric: VersionEffectiveness): boolean {
  return metric.total >= 5
    && metric.cleanRate >= 0.75
    && metric.abortedRate <= 0.10;
}

export function selectSafetyRecovery(
  record: LearnedProtocolRecord,
  activeOutcomes: LearnedOutcomeReceipt[],
  priorMetrics: Map<string, VersionEffectiveness>,
): SafetyRecovery | null {
  if (record.state !== "active" || !record.activeVersionId || activeOutcomes.length < 3) return null;
  const latestThree = activeOutcomes.slice(-3);
  const hardRegression = latestThree.filter((entry) => entry.outcome === "aborted").length >= 2
    || latestThree.every((entry) => entry.outcome !== "clean");
  const latestFive = activeOutcomes.slice(-5);
  const current = latestFive.length === 5 ? windowMetrics(latestFive) : null;
  const sustainedRegression = current !== null && current.cleanRate <= 0.40 && current.quality <= 0.50;
  if (!hardRegression && !sustainedRegression) return null;

  const prior = [...record.versions].reverse().find((version) => {
    if (version.id === record.activeVersionId) return false;
    const metric = priorMetrics.get(version.id);
    if (!metric || !healthyPrior(metric)) return false;
    return hardRegression || (current !== null && metric.qualityScore - current.quality >= 0.25);
  });
  if (prior) {
    return {
      kind: "rollback",
      targetVersionId: prior.id,
      reason: hardRegression ? "Safety rollback: hard regression" : "Safety rollback: sustained regression",
      cause: "safety",
    };
  }
  return {
    kind: "archive",
    reason: hardRegression ? "Safety archive: hard regression without healthy prior" : "Safety archive: sustained regression without healthy prior",
    cause: "safety",
  };
}
