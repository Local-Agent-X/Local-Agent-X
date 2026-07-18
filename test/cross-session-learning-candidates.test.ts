import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DetectedPattern, SessionData } from "../src/cognition/cross-session-learning/types.js";

const DAY = 24 * 60 * 60 * 1000;

function workflow(occurrences = 3): DetectedPattern {
  return {
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
