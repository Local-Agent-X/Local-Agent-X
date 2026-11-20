import { describe, expect, it } from "vitest";
import {
  deriveCandidateId,
  TERMINAL_TELEMETRY_IDENTITY,
  WORKFLOW_TACTIC_IDENTITY,
} from "../cognition/cross-session-learning/types.js";
import type { LearnedOutcomeReceipt, VersionEffectiveness } from "./learned-effectiveness.js";
import type { LearnedProtocolRecord, LearnedProtocolVersion } from "./learned-lifecycle.js";
import { selectSafetyRecovery } from "./learned-refinement.js";

const ID = deriveCandidateId("workflow", "Workflow", ["read_file -> run_tests"]);

function version(id: string, occurrences = 3, sessions = 1, confidence = 0.85): LearnedProtocolVersion {
  return {
    id, sha256: "a".repeat(64), createdAt: new Date(1).toISOString(),
    metadata: {
      ...WORKFLOW_TACTIC_IDENTITY,
      candidateId: ID, confidence, toolSequence: ["read_file", "run_tests"],
      evidenceSnapshot: {
        ...TERMINAL_TELEMETRY_IDENTITY,
        occurrences,
        outcomeStats: { distinctSessions: sessions },
      },
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

describe("learned probation monitor", () => {
  it("waits for three probation outcomes and rolls hard regression to newest healthy prior", () => {
    const metrics = new Map([["v1", metric("v1")], ["v2", metric("v2")]]);
    expect(selectSafetyRecovery(record(), [receipt(1, "aborted"), receipt(2, "aborted")], metrics)).toBeNull();
    expect(selectSafetyRecovery(record(), [receipt(1, "aborted"), receipt(2, "clean"), receipt(3, "aborted")], metrics)).toEqual({
      kind: "rollback", targetVersionId: "v2", reason: "Safety rollback: hard regression", cause: "safety",
    });
  });

  it("detects sustained regression and archives when no healthy prior exists", () => {
    const outcomes = ["aborted", "aborted", "clean", "clean", "partial"]
      .map((outcome, index) => receipt(index, outcome as "clean" | "partial" | "aborted"));
    expect(selectSafetyRecovery(record(), outcomes, new Map([["v1", metric("v1")], ["v2", metric("v2")]]))).toMatchObject({
      kind: "rollback", targetVersionId: "v2", reason: "Safety rollback: sustained regression",
    });
    expect(selectSafetyRecovery(record(), outcomes, new Map())).toEqual({
      kind: "archive", reason: "Safety archive: sustained regression without healthy prior", cause: "safety",
    });
  });

  it("does nothing without committed outcomes or on a clean probation window", () => {
    expect(selectSafetyRecovery(record(), [], new Map())).toBeNull();
    expect(selectSafetyRecovery(record(), [receipt(1, "clean"), receipt(2, "partial"), receipt(3, "clean")], new Map())).toBeNull();
  });
});
