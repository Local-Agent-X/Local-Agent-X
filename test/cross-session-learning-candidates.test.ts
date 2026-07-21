import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DetectedPattern, SessionData } from "../src/cognition/cross-session-learning/types.js";
import {
  hasCandidateEvidenceIdentity,
  hasPatternEvidenceIdentity,
  TERMINAL_TELEMETRY_IDENTITY,
  WORKFLOW_TACTIC_IDENTITY,
} from "../src/cognition/cross-session-learning/types.js";

const DAY = 24 * 60 * 60 * 1000;

function workflow(occurrences = 3): DetectedPattern {
  return {
    ...WORKFLOW_TACTIC_IDENTITY,
    sourceEvidence: TERMINAL_TELEMETRY_IDENTITY,
    type: "workflow",
    description: `Workflow \"coding:read -> edit -> bash\" completed cleanly ${occurrences}/${occurrences} times`,
    occurrences,
    lastSeen: occurrences,
    examples: ["read -> edit -> bash"],
    automationEligible: true,
    outcomeStats: {
      clean: occurrences,
      partial: 0,
      aborted: 0,
      successRate: 1,
      weightedSuccessRate: 1,
      distinctSessions: occurrences,
    },
  };
}

describe("learned candidate lifecycle", () => {
  const originalDataDir = process.env.LAX_DATA_DIR;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "lax-candidate-test-"));
    process.env.LAX_DATA_DIR = dataDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = originalDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("keeps a stable identity while preserving the original evidence snapshot", async () => {
    const { CrossSessionLearner } = await import("../src/cognition/cross-session-learning/learner.js");
    const learner = CrossSessionLearner.getInstance();
    const first = learner.captureCandidate(workflow(3), 100)!;
    const duplicate = learner.captureCandidate(workflow(6), 200)!;

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.evidence.occurrences).toBe(3);
    expect(learner.getCandidates()).toHaveLength(1);
    const persisted = JSON.parse(
      readFileSync(join(dataDir, "cross-session-data.json"), "utf8"),
    ) as SessionData;
    expect(persisted.candidates).toEqual([first]);

    vi.resetModules();
    const reloadedModule = await import("../src/cognition/cross-session-learning/learner.js");
    expect(reloadedModule.CrossSessionLearner.getInstance().getCandidates()).toEqual([first]);
  });

  it("persists valid transitions and rejects lifecycle shortcuts", async () => {
    const { CrossSessionLearner } = await import("../src/cognition/cross-session-learning/learner.js");
    const learner = CrossSessionLearner.getInstance();
    const candidate = learner.captureCandidate(workflow(), 100)!;

    expect(() => learner.setCandidateState(candidate.id, "active", undefined, 110)).toThrow(
      "candidate -> active",
    );
    expect(() => learner.setCandidateState(candidate.id, "approved", undefined, 99)).toThrow(
      "predates current state",
    );
    const approved = learner.setCandidateState(candidate.id, "approved", "Reviewed", 120);
    const active = learner.setCandidateState(candidate.id, "active", undefined, 130);
    const rolledBack = learner.setCandidateState(candidate.id, "rolled-back", "Regression", 140);

    expect(hasCandidateEvidenceIdentity(approved)).toBe(true);
    expect(hasCandidateEvidenceIdentity(active)).toBe(true);
    expect(hasCandidateEvidenceIdentity(rolledBack)).toBe(true);
    expect(approved.state).toBe("approved");
    expect(active.state).toBe("active");
    expect(rolledBack.transitions).toEqual([
      { from: "candidate", to: "approved", timestamp: 120, reason: "Reviewed" },
      { from: "approved", to: "active", timestamp: 130 },
      { from: "active", to: "rolled-back", timestamp: 140, reason: "Regression" },
    ]);
    expect(() => learner.setCandidateState("missing", "approved")).toThrow("Unknown learned candidate");
  });

  it("suppresses rejected duplicates until cooldown expires", async () => {
    const { CrossSessionLearner } = await import("../src/cognition/cross-session-learning/learner.js");
    const learner = CrossSessionLearner.getInstance();
    const candidate = learner.captureCandidate(workflow(), 100)!;
    const rejected = learner.setCandidateState(candidate.id, "rejected", "Not useful", 200);

    const suppressed = learner.captureCandidate(workflow(4), 200 + 29 * DAY)!;
    expect(suppressed).toEqual(rejected);
    expect(learner.getCandidates()).toHaveLength(1);

    const revived = learner.captureCandidate(workflow(5), 200 + 30 * DAY)!;
    expect(revived.state).toBe("candidate");
    expect(revived.evidence.occurrences).toBe(5);
    expect(revived.transitions.at(-1)).toMatchObject({
      from: "rejected",
      to: "candidate",
      reason: "New evidence after suppression period",
    });
    expect(revived.rejectionCooldownUntil).toBeUndefined();
  });

  it("does not capture ineligible automation evidence", async () => {
    const { CrossSessionLearner } = await import("../src/cognition/cross-session-learning/learner.js");
    const learner = CrossSessionLearner.getInstance();
    expect(learner.captureCandidate({ ...workflow(), automationEligible: false })).toBeNull();
    expect(learner.getCandidates()).toEqual([]);
  });

  it("rejects incomplete, conflicting, and identity-less live authority", async () => {
    const { CrossSessionLearner } = await import("../src/cognition/cross-session-learning/learner.js");
    const learner = CrossSessionLearner.getInstance();
    const identityless = workflow();
    delete identityless.evidenceClass;
    delete identityless.authority;
    const partial = workflow();
    delete partial.authority;
    const conflicting = { ...workflow(), sourceEvidence: WORKFLOW_TACTIC_IDENTITY };

    expect(learner.captureCandidate(identityless)).toBeNull();
    expect(learner.captureCandidate(partial)).toBeNull();
    expect(learner.captureCandidate(conflicting)).toBeNull();
    expect(learner.getCandidates()).toEqual([]);
  });

  it("rejects accessor and proxy-backed authority", async () => {
    const { CrossSessionLearner } = await import("../src/cognition/cross-session-learning/learner.js");
    const learner = CrossSessionLearner.getInstance();
    const accessor = workflow();
    Object.defineProperty(accessor, "authority", {
      configurable: true,
      enumerable: true,
      get: () => WORKFLOW_TACTIC_IDENTITY.authority,
    });
    const target = workflow();
    delete target.evidenceClass;
    delete target.authority;
    const proxy = new Proxy(target, {
      getOwnPropertyDescriptor(current, property) {
        if (property === "evidenceClass") {
          return { configurable: true, enumerable: true, value: "workflow-tactic", writable: true };
        }
        if (property === "authority") {
          return { configurable: true, enumerable: true, value: "cross-session-learning", writable: true };
        }
        return Reflect.getOwnPropertyDescriptor(current, property);
      },
    });

    expect(learner.captureCandidate(accessor)).toBeNull();
    expect(learner.captureCandidate(proxy)).toBeNull();
  });

  it("requires source evidence to be an exact two-field plain data identity", async () => {
    const { CrossSessionLearner } = await import("../src/cognition/cross-session-learning/learner.js");
    const learner = CrossSessionLearner.getInstance();
    let reads = 0;
    const accessor = workflow();
    accessor.sourceEvidence = {} as typeof accessor.sourceEvidence;
    Object.defineProperty(accessor.sourceEvidence, "evidenceClass", {
      enumerable: true, get() { reads++; throw new Error("source getter executed"); },
    });
    Object.defineProperty(accessor.sourceEvidence, "authority", {
      enumerable: true, value: "canonical-operation",
    });
    const serialized = workflow();
    serialized.sourceEvidence = { ...TERMINAL_TELEMETRY_IDENTITY, toJSON() { reads++; return {}; } } as typeof serialized.sourceEvidence;

    expect(hasPatternEvidenceIdentity(accessor)).toBe(false);
    expect(hasPatternEvidenceIdentity(serialized)).toBe(false);
    expect(learner.captureCandidate(accessor)).toBeNull();
    expect(learner.captureCandidate(serialized)).toBeNull();
    expect(reads).toBe(0);
  });

  it("rejects hostile refinement opportunities before property access", async () => {
    const { CrossSessionLearner } = await import("../src/cognition/cross-session-learning/learner.js");
    const learner = CrossSessionLearner.getInstance();
    const candidate = learner.captureCandidate(workflow(), 100)!;
    const revoked = Proxy.revocable(structuredClone(candidate), {});
    revoked.revoke();
    let reads = 0;
    const accessor = structuredClone(candidate);
    Object.defineProperty(accessor, "confidence", {
      enumerable: true, get() { reads++; throw new Error("confidence getter executed"); },
    });

    expect(() => learner.draftCandidate(candidate.id, revoked.proxy)).toThrow("Invalid learned refinement opportunity");
    expect(() => learner.draftCandidate(candidate.id, revoked.proxy)).not.toThrow(TypeError);
    expect(() => learner.draftCandidate(candidate.id, accessor)).toThrow("Invalid learned refinement opportunity");
    expect(reads).toBe(0);
  });

  it("rejects impossible or explicitly undefined outcome statistics", async () => {
    const { CrossSessionLearner } = await import("../src/cognition/cross-session-learning/learner.js");
    const learner = CrossSessionLearner.getInstance();
    const impossible = [
      { clean: 3, partial: 1, aborted: 0, successRate: 1, weightedSuccessRate: 1, distinctSessions: 3 },
      { clean: 3, partial: 0, aborted: 0, successRate: 1, weightedSuccessRate: 1, distinctSessions: 4 },
      { clean: 2, partial: 1, aborted: 0, successRate: 1, weightedSuccessRate: 0.8, distinctSessions: 3 },
      { clean: 2, partial: 1, aborted: 0, successRate: 2 / 3, weightedSuccessRate: 1, distinctSessions: 3 },
    ].map((outcomeStats) => ({ ...workflow(), outcomeStats }));
    const undefinedStats = workflow();
    undefinedStats.outcomeStats = undefined;

    expect(impossible.every((pattern) => !hasPatternEvidenceIdentity(pattern))).toBe(true);
    expect(hasPatternEvidenceIdentity(undefinedStats)).toBe(false);
    expect(impossible.every((pattern) => learner.captureCandidate(pattern) === null)).toBe(true);
    expect(learner.captureCandidate(undefinedStats)).toBeNull();
  });

  it("does not certify an exact-label candidate with an incomplete producer shape", async () => {
    const { CrossSessionLearner } = await import("../src/cognition/cross-session-learning/learner.js");
    const candidate = CrossSessionLearner.getInstance().captureCandidate(workflow(), 100)!;
    delete (candidate.suggestion as { name?: string }).name;

    expect(hasCandidateEvidenceIdentity(candidate)).toBe(false);
    const { draftLearnedCandidate } = await import("../src/protocols/learned-drafting.js");
    expect(() => draftLearnedCandidate(candidate)).toThrow(/mismatched evidence authority/);
  });

  it("binds candidate identity to evidence and rejects undefined optional fields", async () => {
    const { CrossSessionLearner } = await import("../src/cognition/cross-session-learning/learner.js");
    const { candidateIdFor } = await import("../src/cognition/cross-session-learning/suggestions.js");
    const candidate = CrossSessionLearner.getInstance().captureCandidate(workflow(), 100)!;
    const mismatched = structuredClone(candidate);
    mismatched.id = "learned-0123456789abcdefabcd";
    const undefinedOptional = structuredClone(candidate);
    undefinedOptional.lastSurfacedAt = undefined;

    expect(hasCandidateEvidenceIdentity(candidate)).toBe(true);
    expect(candidate.id).toBe(candidateIdFor(workflow()));
    expect(hasCandidateEvidenceIdentity(mismatched)).toBe(false);
    expect(hasCandidateEvidenceIdentity(undefinedOptional)).toBe(false);
  });

  it("rejects incomplete, illegal, discontinuous, and temporally forged lifecycle histories", async () => {
    const { CrossSessionLearner } = await import("../src/cognition/cross-session-learning/learner.js");
    const candidate = CrossSessionLearner.getInstance().captureCandidate(workflow(), 100)!;
    const activeWithoutHistory = { ...structuredClone(candidate), state: "active" } as typeof candidate;
    const illegal = { ...structuredClone(candidate), state: "active", updatedAt: 110,
      transitions: [{ from: "candidate", to: "active", timestamp: 110 }] } as typeof candidate;
    const discontinuous = { ...structuredClone(candidate), state: "active", updatedAt: 120,
      transitions: [{ from: "candidate", to: "approved", timestamp: 110 }, { from: "candidate", to: "active", timestamp: 120 }] } as typeof candidate;
    const badTimestamp = { ...structuredClone(candidate), state: "approved", updatedAt: 120,
      transitions: [{ from: "candidate", to: "approved", timestamp: 99 }] } as typeof candidate;
    const wrongFinal = { ...structuredClone(candidate), state: "approved", updatedAt: 120,
      transitions: [{ from: "candidate", to: "rejected", timestamp: 120 }] } as typeof candidate;

    expect([activeWithoutHistory, illegal, discontinuous, badTimestamp, wrongFinal]
      .every((entry) => !hasCandidateEvidenceIdentity(entry))).toBe(true);
  });

  it("keeps archived candidates suppressed until explicitly restored", async () => {
    const { CrossSessionLearner } = await import("../src/cognition/cross-session-learning/learner.js");
    const learner = CrossSessionLearner.getInstance();
    const candidate = learner.captureCandidate(workflow(), 100)!;
    const archived = learner.setCandidateState(candidate.id, "archived", undefined, 200);

    expect(learner.captureCandidate(workflow(8), 300)).toEqual(archived);
    const restored = learner.setCandidateState(candidate.id, "candidate", "Restore", 400);
    expect(restored.state).toBe("candidate");
  });
});
