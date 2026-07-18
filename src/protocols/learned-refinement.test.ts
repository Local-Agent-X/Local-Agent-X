import { describe, expect, it } from "vitest";
import type { LearnedCandidate } from "../cognition/cross-session-learning/types.js";
import type { LearnedOutcomeReceipt, VersionEffectiveness } from "./learned-effectiveness.js";
import type { LearnedProtocolRecord, LearnedProtocolVersion } from "./learned-lifecycle.js";
import { isSafeRefinementVersion, isStrongerRefinement, selectSafetyRecovery } from "./learned-refinement.js";

const ID = "learned-0123456789abcdefabcd";

function candidate(overrides: Partial<LearnedCandidate> = {}): LearnedCandidate {
  const outcomes = { clean: 6, partial: 0, aborted: 0, successRate: 1, weightedSuccessRate: 1, distinctSessions: 3 };
  return {
    id: ID, state: "active", confidence: 0.85,
    suggestion: { type: "mission", name: "Workflow", description: "Workflow", config: { sequence: ["read_file -> run_tests"] } },
    evidence: {
      patternType: "workflow", description: "Workflow", occurrences: 6, lastSeen: 1,
      examples: ["read_file -> run_tests"], outcomeStats: outcomes,
    },
    createdAt: 1, updatedAt: 1, transitions: [], ...overrides,
  };
}

function version(id: string, occurrences = 3, sessions = 1, confidence = 0.85): LearnedProtocolVersion {
  return {
    id, sha256: "a".repeat(64), createdAt: new Date(1).toISOString(),
    metadata: {
      candidateId: ID, confidence, toolSequence: ["read_file", "run_tests"],
      evidenceSnapshot: { occurrences, outcomeStats: { distinctSessions: sessions } },
    },
  };
}

function targetVersion(overrides: Record<string, unknown> = {}): LearnedProtocolVersion {
  const evidence = candidate().evidence;
  return {
    id: "target", sha256: "b".repeat(64), createdAt: new Date(2).toISOString(),
    metadata: {
      candidateId: ID, confidence: 0.85, toolSequence: ["read_file", "run_tests"],
      evidenceSnapshot: evidence, ...overrides,
    },
  };
}

function receipt(index: number, outcome: "clean" | "partial" | "aborted", versionId = "v3"): LearnedOutcomeReceipt {
  return {
    schemaVersion: 1, status: "committed", opId: `op-${index}`, sessionId: `s-${index}`,
    slug: ID, versionId, candidateId: ID, outcome, timestamp: index + 1,
  };
}

function metric(versionId: string, qualityScore = 1): VersionEffectiveness {
  return {
    slug: ID, versionId, candidateId: ID, total: 5, clean: 5, partial: 0, aborted: 0,
    cleanRate: 1, partialRate: 0, abortedRate: 0, qualityScore, distinctSessions: 5, lastOutcomeAt: 1,
  };
}

function record(): LearnedProtocolRecord {
  return {
    schemaVersion: 1, slug: ID, state: "active", activeVersionId: "v3",
    versions: [version("v1"), version("v2"), version("v3")],
  };
}

describe("learned refinement policy", () => {
  it("enforces promotion thresholds and either stronger-evidence boundary", () => {
    expect(isStrongerRefinement(candidate(), version("old", 3, 3))).toBe(true);
    expect(isStrongerRefinement(candidate(), version("old", 6, 1))).toBe(true);
    const exactBoundary = candidate();
    exactBoundary.evidence.occurrences = 20;
    exactBoundary.evidence.outcomeStats = {
      clean: 17, partial: 2, aborted: 1, successRate: 0.85,
      weightedSuccessRate: 0.9, distinctSessions: 3,
    };
    expect(isStrongerRefinement(exactBoundary, version("old", 17, 3))).toBe(true);
    expect(isStrongerRefinement(candidate(), version("old", 4, 2))).toBe(false);
    expect(isStrongerRefinement(candidate({ confidence: 0.849 }), version("old", 3, 1))).toBe(false);
    const noisy = candidate();
    noisy.evidence.outcomeStats = { clean: 5, partial: 0, aborted: 1, successRate: 5 / 6, weightedSuccessRate: 5 / 6, distinctSessions: 3 };
    expect(isStrongerRefinement(noisy, version("old", 3, 1))).toBe(false);
  });

  it("applies the same gate to persisted inactive versions", () => {
    expect(isSafeRefinementVersion(version("active", 3, 1), targetVersion(), ID)).toBe(true);
    expect(isSafeRefinementVersion(version("active", 3, 1), targetVersion({ confidence: 0.80 }), ID)).toBe(false);
    expect(isSafeRefinementVersion(version("active", 3, 1), targetVersion({ toolSequence: ["shell"] }), ID)).toBe(false);
    expect(isSafeRefinementVersion(version("active", 4, 2), targetVersion(), ID)).toBe(false);
    expect(isSafeRefinementVersion(version("active", 3, 1), targetVersion({ candidateId: "learned-aaaaaaaaaaaaaaaaaaaa" }), ID)).toBe(false);
    const wrongActive = version("active", 3, 1);
    wrongActive.metadata.candidateId = "learned-aaaaaaaaaaaaaaaaaaaa";
    expect(isSafeRefinementVersion(
      wrongActive, targetVersion({ candidateId: "learned-aaaaaaaaaaaaaaaaaaaa" }), ID,
    )).toBe(false);
    const fabricated = candidate().evidence;
    fabricated.outcomeStats!.successRate = 0.99;
    expect(isSafeRefinementVersion(version("active", 3, 1), targetVersion({ evidenceSnapshot: fabricated }), ID)).toBe(false);
  });

  it("waits for three probation outcomes and rolls hard regression to newest healthy prior", () => {
    const metrics = new Map([["v1", metric("v1")], ["v2", metric("v2")]]);
    expect(selectSafetyRecovery(record(), [receipt(1, "aborted"), receipt(2, "aborted")], metrics)).toBeNull();
    expect(selectSafetyRecovery(record(), [receipt(1, "aborted"), receipt(2, "clean"), receipt(3, "aborted")], metrics)).toEqual({
      kind: "rollback", targetVersionId: "v2", reason: "Safety rollback: hard regression",
    });
  });

  it("detects sustained regression and archives when no healthy prior exists", () => {
    const outcomes = ["aborted", "aborted", "clean", "clean", "partial"]
      .map((outcome, index) => receipt(index, outcome as "clean" | "partial" | "aborted"));
    expect(selectSafetyRecovery(record(), outcomes, new Map([["v1", metric("v1")], ["v2", metric("v2")]]))).toMatchObject({
      kind: "rollback", targetVersionId: "v2", reason: "Safety rollback: sustained regression",
    });
    expect(selectSafetyRecovery(record(), outcomes, new Map())).toEqual({
      kind: "archive", reason: "Safety archive: sustained regression without healthy prior",
    });
  });

  it("does nothing without committed outcomes or on a clean probation window", () => {
    expect(selectSafetyRecovery(record(), [], new Map())).toBeNull();
    expect(selectSafetyRecovery(record(), [receipt(1, "clean"), receipt(2, "partial"), receipt(3, "clean")], new Map())).toBeNull();
  });
});
