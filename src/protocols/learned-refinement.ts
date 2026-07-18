import type { LearnedCandidate } from "../cognition/cross-session-learning/types.js";
import type { LearnedOutcomeReceipt, VersionEffectiveness } from "./learned-effectiveness.js";
import type { LearnedProtocolRecord, LearnedProtocolVersion } from "./learned-lifecycle.js";

const PROMOTION_RATE = 0.85;

interface DraftMetadata {
  candidateId?: unknown;
  confidence?: unknown;
  toolSequence?: unknown;
  evidenceSnapshot?: { occurrences?: unknown; outcomeStats?: { distinctSessions?: unknown } };
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
  const stats = candidate.evidence.outcomeStats;
  const metadata = latest.metadata as DraftMetadata;
  const priorOccurrences = metadata.evidenceSnapshot?.occurrences;
  const priorSessions = metadata.evidenceSnapshot?.outcomeStats?.distinctSessions;
  const tools = candidateTools(candidate);
  if (
    candidate.state !== "active"
    || !stats
    || !tools
    || metadata.candidateId !== candidate.id
    || !Array.isArray(metadata.toolSequence)
    || JSON.stringify(metadata.toolSequence) !== JSON.stringify(tools)
    || typeof metadata.confidence !== "number"
    || typeof priorOccurrences !== "number"
    || typeof priorSessions !== "number"
  ) return false;
  const total = stats.clean + stats.partial + stats.aborted;
  if (
    total !== candidate.evidence.occurrences
    || total <= 0
    || stats.clean < 5
    || stats.distinctSessions < 3
    || stats.successRate < PROMOTION_RATE
    || stats.weightedSuccessRate < PROMOTION_RATE
    || stats.aborted / total > 0.10
    || candidate.confidence < PROMOTION_RATE
    || candidate.confidence < metadata.confidence
  ) return false;
  return candidate.evidence.occurrences >= priorOccurrences + 3
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
