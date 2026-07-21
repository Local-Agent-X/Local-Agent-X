import type { LearnedCandidate } from "../cognition/cross-session-learning/types.js";
import {
  hasCandidateEvidenceIdentity,
  hasEvidenceIdentity,
  isSafeLearnedStringArray,
  readOwnEnumerableData,
  TERMINAL_TELEMETRY_IDENTITY,
  WORKFLOW_TACTIC_IDENTITY,
} from "../cognition/cross-session-learning/types.js";
import type { LearnedOutcomeReceipt, VersionEffectiveness } from "./learned-effectiveness.js";
import type { LearnedProtocolRecord, LearnedProtocolVersion } from "./learned-lifecycle.js";

const PROMOTION_RATE = 0.85;

export type SafetyRecovery =
  | { kind: "rollback"; targetVersionId: string; reason: string }
  | { kind: "archive"; reason: string };

function field(value: unknown, key: PropertyKey): unknown {
  const read = readOwnEnumerableData(value, key);
  return read.ok ? read.value : undefined;
}

function expandedTools(sequence: unknown): string[] | null {
  if (!isSafeLearnedStringArray(sequence) || sequence.length === 0) return null;
  const tools: string[] = [];
  for (let index = 0; index < sequence.length; index++) {
    tools.push(...sequence[index].split(" -> ").map((tool) => tool.trim()).filter(Boolean));
  }
  return tools;
}

function sameStrings(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function isStrongerRefinement(
  candidate: LearnedCandidate,
  latest: LearnedProtocolVersion,
): boolean {
  if (!hasCandidateEvidenceIdentity(candidate)) return false;
  const tools = expandedTools(field(field(field(candidate, "suggestion"), "config"), "sequence"));
  const id = field(candidate, "id");
  const state = field(candidate, "state");
  const confidence = field(candidate, "confidence");
  const evidence = field(candidate, "evidence");
  const prior = field(latest, "metadata");
  return state === "active"
    && typeof id === "string"
    && typeof confidence === "number"
    && tools !== null
    && passesPromotion(id, tools, evidence, confidence, prior);
}

export function isSafeRefinementVersion(
  active: LearnedProtocolVersion,
  target: LearnedProtocolVersion,
  expectedCandidateId: string,
): boolean {
  const metadata = field(target, "metadata");
  const candidateId = field(metadata, "candidateId");
  const toolSequence = field(metadata, "toolSequence");
  const confidence = field(metadata, "confidence");
  if (
    !hasEvidenceIdentity(metadata, WORKFLOW_TACTIC_IDENTITY)
    || candidateId !== expectedCandidateId
    || !isSafeLearnedStringArray(toolSequence)
    || typeof confidence !== "number"
  ) return false;
  return passesPromotion(
    candidateId,
    toolSequence,
    field(metadata, "evidenceSnapshot"),
    confidence,
    field(active, "metadata"),
  );
}

function passesPromotion(
  candidateId: string,
  tools: string[],
  evidenceValue: unknown,
  confidence: number,
  priorValue: unknown,
): boolean {
  if (!hasEvidenceIdentity(evidenceValue, TERMINAL_TELEMETRY_IDENTITY)) return false;
  const stats = field(evidenceValue, "outcomeStats");
  const priorEvidence = field(priorValue, "evidenceSnapshot");
  if (
    !hasEvidenceIdentity(priorValue, WORKFLOW_TACTIC_IDENTITY)
    || !hasEvidenceIdentity(priorEvidence, TERMINAL_TELEMETRY_IDENTITY)
  ) return false;
  const priorOccurrences = field(priorEvidence, "occurrences");
  const priorSessions = field(field(priorEvidence, "outcomeStats"), "distinctSessions");
  const priorCandidateId = field(priorValue, "candidateId");
  const priorTools = field(priorValue, "toolSequence");
  const priorConfidence = field(priorValue, "confidence");
  const clean = field(stats, "clean");
  const partial = field(stats, "partial");
  const aborted = field(stats, "aborted");
  const successRate = field(stats, "successRate");
  const weightedSuccessRate = field(stats, "weightedSuccessRate");
  const distinctSessions = field(stats, "distinctSessions");
  const occurrences = field(evidenceValue, "occurrences");
  if (
    tools.length === 0
    || priorCandidateId !== candidateId
    || !isSafeLearnedStringArray(priorTools)
    || !sameStrings(priorTools, tools)
    || typeof priorConfidence !== "number"
    || !Number.isFinite(priorConfidence)
    || priorConfidence < 0
    || priorConfidence > 1
    || typeof priorOccurrences !== "number"
    || !Number.isInteger(priorOccurrences)
    || priorOccurrences < 0
    || typeof priorSessions !== "number"
    || !Number.isInteger(priorSessions)
    || priorSessions < 0
  ) return false;
  if (
    typeof clean !== "number"
    || typeof partial !== "number"
    || typeof aborted !== "number"
    || typeof successRate !== "number"
    || typeof weightedSuccessRate !== "number"
    || typeof distinctSessions !== "number"
    || typeof occurrences !== "number"
  ) return false;
  const total = clean + partial + aborted;
  if (
    ![clean, partial, aborted, successRate, weightedSuccessRate, distinctSessions, confidence]
      .every(Number.isFinite)
    || ![clean, partial, aborted, distinctSessions, occurrences]
      .every(Number.isInteger)
    || clean < 0
    || partial < 0
    || aborted < 0
    || distinctSessions < 0
    || total !== occurrences
    || total <= 0
    || clean < 5
    || distinctSessions < 3
    || successRate < PROMOTION_RATE
    || successRate > 1
    || Math.abs(successRate - clean / total) > 1e-9
    || weightedSuccessRate < PROMOTION_RATE
    || weightedSuccessRate > 1
    || aborted / total > 0.10
    || confidence < PROMOTION_RATE
    || confidence > 1
    || confidence < priorConfidence
  ) return false;
  return occurrences >= priorOccurrences + 3
    || distinctSessions >= priorSessions + 2;
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
