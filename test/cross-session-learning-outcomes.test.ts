import { describe, expect, it } from "vitest";
import {
  detectRepeatedTopics,
  detectTimePatterns,
  detectWorkflowPatterns,
} from "../src/cognition/cross-session-learning/detectors.js";
import { suggestAutomation } from "../src/cognition/cross-session-learning/suggestions.js";
import type { ActionEntry } from "../src/cognition/cross-session-learning/types.js";

function outcome(
  opId: string,
  sessionId: string,
  result: "clean" | "partial" | "aborted",
  tools: string[],
  timestamp: number,
): ActionEntry {
  return {
    opId,
    sessionId,
    type: "op_outcome",
    details: `coding:${tools.join(" -> ")}`,
    timestamp,
    outcome: result,
    category: "coding",
    tools,
  };
}

describe("outcome-aware workflow patterns", () => {
  it("promotes repeated clean evidence across distinct sessions", () => {
    const pattern = detectWorkflowPatterns([
      outcome("o1", "s1", "clean", ["read", "edit", "bash"], 1),
      outcome("o2", "s1", "clean", ["read", "edit", "bash"], 2),
      outcome("o3", "s2", "clean", ["read", "edit", "bash"], 3),
    ], 3)[0];

    expect(pattern.automationEligible).toBe(true);
    expect(pattern.outcomeStats).toEqual({
      clean: 3,
      partial: 0,
      aborted: 0,
      successRate: 1,
      weightedSuccessRate: 1,
      distinctSessions: 2,
    });
    expect(suggestAutomation(pattern)?.type).toBe("mission");
  });

  it("turns repeated failures into review evidence, not automation", () => {
    const pattern = detectWorkflowPatterns([
      outcome("o1", "s1", "aborted", ["read", "edit"], 1),
      outcome("o2", "s2", "partial", ["read", "edit"], 2),
      outcome("o3", "s3", "aborted", ["read", "edit"], 3),
    ], 3)[0];

    expect(pattern.automationEligible).toBe(false);
    expect(pattern.suggestedAction).toContain("Review");
    expect(suggestAutomation(pattern)).toBeNull();
  });

  it("does not manufacture distinct sessions from unknown provenance", () => {
    const pattern = detectWorkflowPatterns([
      outcome("o1", "", "clean", ["read", "edit"], 1),
      outcome("o2", "", "clean", ["read", "edit"], 2),
      outcome("o3", "", "clean", ["read", "edit"], 3),
    ], 3)[0];

    expect(pattern.outcomeStats?.distinctSessions).toBe(0);
    expect(pattern.automationEligible).toBe(false);
  });

  it("keeps workflows with the same tools but different order separate", () => {
    const patterns = detectWorkflowPatterns([
      outcome("a1", "s1", "clean", ["read", "edit"], 1),
      outcome("a2", "s2", "clean", ["read", "edit"], 2),
      outcome("a3", "s3", "clean", ["read", "edit"], 3),
      outcome("b1", "s1", "clean", ["edit", "read"], 4),
      outcome("b2", "s2", "clean", ["edit", "read"], 5),
      outcome("b3", "s3", "clean", ["edit", "read"], 6),
    ], 3);

    expect(patterns).toHaveLength(2);
    expect(patterns.map((pattern) => pattern.examples[0])).toEqual([
      "read -> edit",
      "edit -> read",
    ]);
  });

  it("keeps failed outcome receipts out of topic and time automation", () => {
    const failed = [
      outcome("o1", "s1", "aborted", ["read", "edit"], 1),
      outcome("o2", "s2", "partial", ["read", "edit"], 2),
      outcome("o3", "s3", "aborted", ["read", "edit"], 3),
    ];
    expect(detectTimePatterns(failed, 3)).toEqual([]);
    expect(detectRepeatedTopics(failed, 3)).toEqual([]);
  });

  it("rejects empty workflows even when their outcomes are clean", () => {
    const pattern = detectWorkflowPatterns([
      outcome("o1", "s1", "clean", [], 1),
      outcome("o2", "s2", "clean", [], 2),
      outcome("o3", "s3", "clean", [], 3),
    ], 3)[0];
    expect(pattern.automationEligible).toBe(false);
    expect(suggestAutomation(pattern)).toBeNull();
  });

  it("lets recent regressions outweigh old successes", () => {
    const day = 24 * 60 * 60 * 1000;
    const pattern = detectWorkflowPatterns([
      outcome("o1", "s1", "clean", ["read", "edit"], 1),
      outcome("o2", "s2", "clean", ["read", "edit"], 2),
      outcome("o3", "s3", "clean", ["read", "edit"], 3),
      outcome("o4", "s4", "aborted", ["read", "edit"], 30 * day),
    ], 3)[0];
    expect(pattern.outcomeStats?.successRate).toBe(0.75);
    expect(pattern.outcomeStats?.weightedSuccessRate).toBeLessThan(0.75);
    expect(pattern.automationEligible).toBe(false);
  });

  it("uses collision-safe grouping for tool names containing separators", () => {
    const patterns = detectWorkflowPatterns([
      outcome("a1", "s1", "clean", ["a -> b"], 1),
      outcome("a2", "s2", "clean", ["a -> b"], 2),
      outcome("a3", "s3", "clean", ["a -> b"], 3),
      outcome("b1", "s1", "clean", ["a", "b"], 4),
      outcome("b2", "s2", "clean", ["a", "b"], 5),
      outcome("b3", "s3", "clean", ["a", "b"], 6),
    ], 3);
    expect(patterns).toHaveLength(2);
  });
});
