import type { CandidateEvidenceSnapshot, LearnedCandidate } from "../cognition/cross-session-learning/types.js";
import type { LearnedOutcomeReceipt, VersionEffectiveness } from "./learned-effectiveness.js";
import type { LearnedProtocolRecord, LearnedProtocolVersion } from "./learned-lifecycle.js";

const PROMOTION_RATE = 0.85;

interface DraftMetadata {
  candidateId?: unknown;
  confidence?: unknown;
  toolSequence?: unknown;
  evidenceSnapshot?: unknown;
}

export type SafetyRecovery =
  | { kind: "rollback"; targetVersionId: string; reason: string }
  | { kind: "archive"; reason: string };

function candidateTools(candidate: LearnedCandidate): string[] | null {
  const sequence = candidate.suggestion.config.sequence;
  if (!Array.isArray(sequence) || !sequence.every((step) => typeof step === "string")) return null;
  return sequence.flatMap((step) => step.split(" -> ").map((tool) => tool.trim()).filter(Boolean));
}

export function isStrongerRefinement(
  candidate: LearnedCandidate,
  latest: LearnedProtocolVersion,
): boolean {
  const tools = candidateTools(candidate);
  return candidate.state === "active" && tools !== null && passesPromotion(
    candidate.id, tools, candidate.evidence, candidate.confidence, latest.metadata as DraftMetadata,
  );
}

export function isSafeRefinementVersion(
  active: LearnedProtocolVersion,
  target: LearnedProtocolVersion,
  expectedCandidateId: string,
): boolean {
  const metadata = target.metadata as DraftMetadata;
  if (
    metadata.candidateId !== expectedCandidateId
    || !Array.isArray(metadata.toolSequence)
    || metadata.toolSequence.some((tool) => typeof tool !== "string")
    || typeof metadata.confidence !== "number"
  ) return false;
  return passesPromotion(
    metadata.candidateId,
    metadata.toolSequence as string[],
    metadata.evidenceSnapshot,
    metadata.confidence,
    active.metadata as DraftMetadata,
  );
}

function passesPromotion(
  candidateId: string,
  tools: string[],
  evidenceValue: unknown,
  confidence: number,
  prior: DraftMetadata,
): boolean {
  const evidence = evidenceValue as CandidateEvidenceSnapshot | undefined;
  const stats = evidence?.outcomeStats;
  const priorEvidence = prior.evidenceSnapshot as CandidateEvidenceSnapshot | undefined;
  const priorOccurrences = priorEvidence?.occurrences;
  const priorSessions = priorEvidence?.outcomeStats?.distinctSessions;
  if (
    !stats
    || tools.length === 0
    || prior.candidateId !== candidateId
    || !Array.isArray(prior.toolSequence)
    || JSON.stringify(prior.toolSequence) !== JSON.stringify(tools)
    || typeof prior.confidence !== "number"
    || !Number.isFinite(prior.confidence)
    || prior.confidence < 0
    || prior.confidence > 1
    || typeof priorOccurrences !== "number"
    || !Number.isInteger(priorOccurrences)
    || priorOccurrences < 0
    || typeof priorSessions !== "number"
    || !Number.isInteger(priorSessions)
    || priorSessions < 0
  ) return false;
  const total = stats.clean + stats.partial + stats.aborted;
  if (
    ![stats.clean, stats.partial, stats.aborted, stats.successRate, stats.weightedSuccessRate, stats.distinctSessions, confidence]
      .every(Number.isFinite)
    || ![stats.clean, stats.partial, stats.aborted, stats.distinctSessions, evidence.occurrences]
      .every(Number.isInteger)
    || stats.clean < 0
    || stats.partial < 0
    || stats.aborted < 0
    || stats.distinctSessions < 0
    || total !== evidence.occurrences
    || total <= 0
    || stats.clean < 5
    || stats.distinctSessions < 3
    || stats.successRate < PROMOTION_RATE
    || stats.successRate > 1
    || Math.abs(stats.successRate - stats.clean / total) > 1e-9
    || stats.weightedSuccessRate < PROMOTION_RATE
    || stats.weightedSuccessRate > 1
    || stats.aborted / total > 0.10
    || confidence < PROMOTION_RATE
    || confidence > 1
    || confidence < prior.confidence
  ) return false;
  return evidence.occurrences >= priorOccurrences + 3
    || stats.distinctSessions >= priorSessions + 2;
}

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
    };
  }
  return {
    kind: "archive",
    reason: hardRegression ? "Safety archive: hard regression without healthy prior" : "Safety archive: sustained regression without healthy prior",
  };
}
