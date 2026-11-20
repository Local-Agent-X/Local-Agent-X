import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LearnedCandidate, SessionData } from "../src/cognition/cross-session-learning/types.js";
import {
  deriveCandidateId,
  hasCandidateEvidenceIdentity,
  TERMINAL_TELEMETRY_IDENTITY,
  WORKFLOW_TACTIC_IDENTITY,
} from "../src/cognition/cross-session-learning/types.js";

const DAY = 24 * 60 * 60 * 1000;
const NAME = "vendor_portal_release";

/** A workflow-tactic candidate as the retired miner left it on disk. Stores
 *  still carry these, so the identity check must keep judging them. */
function legacyWorkflowCandidate(): LearnedCandidate {
  const description = "workflow";
  const examples = ["read -> edit"];
  return {
    ...WORKFLOW_TACTIC_IDENTITY,
    id: deriveCandidateId("workflow", description, examples),
    state: "candidate",
    confidence: 1,
    suggestion: {
      type: "mission",
      name: "workflow",
      description,
      config: { patternType: "workflow", sequence: examples, occurrences: 3 },
    },
    evidence: {
      ...TERMINAL_TELEMETRY_IDENTITY,
      patternType: "workflow",
      description,
      occurrences: 3,
      lastSeen: 3,
      examples,
      outcomeStats: { clean: 3, partial: 0, aborted: 0, successRate: 1, weightedSuccessRate: 1, distinctSessions: 3 },
    },
    createdAt: 1,
    updatedAt: 1,
    transitions: [],
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

  async function learnerWithCandidate(timestamp = 100) {
    const { CrossSessionLearner } = await import("../src/cognition/cross-session-learning/learner.js");
    const learner = CrossSessionLearner.getInstance();
    const proposed = learner.recordReviewedProposal({
      name: NAME, description: "Release files through the vendor portal", sessionId: "session-a",
      outcome: "verified", timestamp,
    });
    if (!proposed.ok) throw new Error(proposed.reason);
    return { learner, candidate: proposed.candidate };
  }

  it("keeps a stable identity across proposals, persists it, and reloads it unchanged", async () => {
    const { learner, candidate: first } = await learnerWithCandidate(100);
    const { reviewedProcedureCandidateId } = await import("../src/cognition/cross-session-learning/reviewed-procedures.js");
    const second = learner.recordReviewedProposal({
      name: NAME, description: "Release files through the vendor portal", sessionId: "session-b",
      outcome: "verified", timestamp: 200,
    });
    if (!second.ok) throw new Error(second.reason);

    expect(second).toMatchObject({ created: false, revived: false });
    expect(second.candidate.id).toBe(first.id);
    expect(first.id).toBe(reviewedProcedureCandidateId(NAME));
    expect(learner.getCandidates()).toHaveLength(1);
    const persisted = JSON.parse(
      readFileSync(join(dataDir, "cross-session-data.json"), "utf8"),
    ) as SessionData;
    expect(persisted.candidates).toEqual([second.candidate]);

    vi.resetModules();
    const reloadedModule = await import("../src/cognition/cross-session-learning/learner.js");
    expect(reloadedModule.CrossSessionLearner.getInstance().getCandidates()).toEqual([second.candidate]);
  });

  it("persists valid transitions and rejects lifecycle shortcuts", async () => {
    const { learner, candidate } = await learnerWithCandidate(100);

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

  it("suppresses a rejected procedure until its cooldown expires", async () => {
    const { learner, candidate } = await learnerWithCandidate(100);
    const rejected = learner.setCandidateState(candidate.id, "rejected", "Not useful", 200);
    const propose = (timestamp: number) => learner.recordReviewedProposal({
      name: NAME, description: "Release files through the vendor portal", sessionId: "session-late",
      outcome: "verified", timestamp,
    });

    expect(propose(200 + 29 * DAY)).toEqual({ ok: false, reason: "discarded" });
    expect(learner.getCandidates()).toEqual([rejected]);

    const revived = propose(200 + 30 * DAY);
    if (!revived.ok) throw new Error(revived.reason);
    expect(revived.revived).toBe(true);
    expect(revived.candidate.state).toBe("candidate");
    expect(revived.candidate.evidence.proposals).toEqual([
      { sessionId: "session-late", timestamp: 200 + 30 * DAY, outcome: "verified" },
    ]);
    expect(revived.candidate.transitions.at(-1)).toMatchObject({
      from: "rejected",
      to: "candidate",
      reason: "Proposed again after the discard cooldown",
    });
    expect(revived.candidate.rejectionCooldownUntil).toBeUndefined();
  });

  it("rejects a legacy candidate with impossible or explicitly undefined outcome statistics", () => {
    const impossible = [
      { clean: 3, partial: 1, aborted: 0, successRate: 1, weightedSuccessRate: 1, distinctSessions: 3 },
      { clean: 3, partial: 0, aborted: 0, successRate: 1, weightedSuccessRate: 1, distinctSessions: 4 },
      { clean: 2, partial: 1, aborted: 0, successRate: 1, weightedSuccessRate: 0.8, distinctSessions: 3 },
      { clean: 2, partial: 1, aborted: 0, successRate: 2 / 3, weightedSuccessRate: 1, distinctSessions: 3 },
    ].map((outcomeStats) => {
      const legacy = legacyWorkflowCandidate();
      legacy.evidence.outcomeStats = outcomeStats;
      return legacy;
    });
    const undefinedStats = legacyWorkflowCandidate();
    undefinedStats.evidence.outcomeStats = undefined;

    expect(hasCandidateEvidenceIdentity(legacyWorkflowCandidate())).toBe(true);
    expect(impossible.every((candidate) => !hasCandidateEvidenceIdentity(candidate))).toBe(true);
    expect(hasCandidateEvidenceIdentity(undefinedStats)).toBe(false);
  });

  it("does not certify an exact-label candidate with an incomplete producer shape", async () => {
    const { candidate } = await learnerWithCandidate();
    delete (candidate.suggestion as { name?: string }).name;
    const legacy = legacyWorkflowCandidate();
    delete (legacy.suggestion as { name?: string }).name;

    expect(hasCandidateEvidenceIdentity(candidate)).toBe(false);
    expect(hasCandidateEvidenceIdentity(legacy)).toBe(false);
  });

  it("binds candidate identity to evidence and rejects undefined optional fields", async () => {
    const { candidate } = await learnerWithCandidate();
    for (const subject of [candidate, legacyWorkflowCandidate()]) {
      const mismatched = structuredClone(subject);
      mismatched.id = "learned-0123456789abcdefabcd";
      const undefinedOptional = structuredClone(subject);
      undefinedOptional.lastSurfacedAt = undefined;

      expect(hasCandidateEvidenceIdentity(subject)).toBe(true);
      expect(hasCandidateEvidenceIdentity(mismatched)).toBe(false);
      expect(hasCandidateEvidenceIdentity(undefinedOptional)).toBe(false);
    }
  });

  it("rejects incomplete, illegal, discontinuous, and temporally forged lifecycle histories", async () => {
    const { candidate } = await learnerWithCandidate(100);
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

  it("keeps archived candidates archived through new proposals until explicitly restored", async () => {
    const { learner, candidate } = await learnerWithCandidate(100);
    const archived = learner.setCandidateState(candidate.id, "archived", undefined, 200);

    const proposed = learner.recordReviewedProposal({
      name: NAME, description: "Release files through the vendor portal", sessionId: "session-b",
      outcome: "verified", timestamp: 300,
    });
    if (!proposed.ok) throw new Error(proposed.reason);
    expect(proposed.candidate.state).toBe("archived");
    expect(proposed.candidate.transitions).toEqual(archived.transitions);
    const restored = learner.setCandidateState(candidate.id, "candidate", "Restore", 400);
    expect(restored.state).toBe("candidate");
  });
});
