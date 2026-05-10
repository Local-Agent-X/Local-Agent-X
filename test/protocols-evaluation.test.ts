import { describe, it, expect } from "vitest";
import { evaluateCondition, resolveNextStep, dryRunProtocol } from "../src/protocols/evaluation.js";
import type { Protocol, ProtocolStep } from "../src/protocols/types.js";

describe("evaluateCondition", () => {
  it("equals matches value", () => {
    expect(evaluateCondition({ field: "x", operator: "equals", value: 1 }, { x: 1 })).toBe(true);
    expect(evaluateCondition({ field: "x", operator: "equals", value: 2 }, { x: 1 })).toBe(false);
  });

  it("not_equals", () => {
    expect(evaluateCondition({ field: "x", operator: "not_equals", value: 1 }, { x: 2 })).toBe(true);
  });

  it("exists / not_exists", () => {
    expect(evaluateCondition({ field: "x", operator: "exists" }, { x: 1 })).toBe(true);
    expect(evaluateCondition({ field: "x", operator: "exists" }, {})).toBe(false);
    expect(evaluateCondition({ field: "x", operator: "exists" }, { x: null })).toBe(false);
    expect(evaluateCondition({ field: "x", operator: "not_exists" }, {})).toBe(true);
  });

  it("contains / not_contains require both sides to be strings", () => {
    expect(evaluateCondition({ field: "s", operator: "contains", value: "ab" }, { s: "xabx" })).toBe(true);
    expect(evaluateCondition({ field: "s", operator: "contains", value: "ab" }, { s: "xyz" })).toBe(false);
    expect(evaluateCondition({ field: "s", operator: "not_contains", value: "ab" }, { s: "xyz" })).toBe(true);
    // Number on either side returns false (not a string match)
    expect(evaluateCondition({ field: "s", operator: "contains", value: "ab" }, { s: 42 })).toBe(false);
  });

  it("gt / lt require both sides to be numbers", () => {
    expect(evaluateCondition({ field: "n", operator: "gt", value: 5 }, { n: 10 })).toBe(true);
    expect(evaluateCondition({ field: "n", operator: "lt", value: 5 }, { n: 10 })).toBe(false);
    expect(evaluateCondition({ field: "n", operator: "gt", value: 5 }, { n: "10" })).toBe(false);
  });
});

describe("resolveNextStep", () => {
  const steps: ProtocolStep[] = [
    { id: "a", instruction: "first" },
    { id: "b", instruction: "second" },
    { id: "c", instruction: "third" },
    { id: "skip", instruction: "skipped" },
  ];

  it("returns the next sequential step when no jump is configured", () => {
    expect(resolveNextStep(steps[0], steps, {})?.id).toBe("b");
  });

  it("honors nextStep override", () => {
    const stepWithJump: ProtocolStep = { id: "x", instruction: "z", nextStep: "skip" };
    const localSteps = [...steps, stepWithJump];
    expect(resolveNextStep(stepWithJump, localSteps, {})?.id).toBe("skip");
  });

  it("returns null past the end of the chain", () => {
    expect(resolveNextStep(steps[steps.length - 1], steps, {})).toBeNull();
  });

  it("when condition fails AND elseStep is set, jumps to elseStep", () => {
    const cond: ProtocolStep = {
      id: "x",
      instruction: "z",
      condition: { field: "v", operator: "equals", value: 1 },
      elseStep: "skip",
    };
    const localSteps = [...steps, cond];
    expect(resolveNextStep(cond, localSteps, { v: 0 })?.id).toBe("skip");
  });

  it("when condition fails AND no elseStep, falls through to next sequential step", () => {
    const cond: ProtocolStep = {
      id: "x",
      instruction: "z",
      condition: { field: "v", operator: "equals", value: 1 },
    };
    const localSteps = [...steps, cond];
    expect(resolveNextStep(cond, localSteps, { v: 0 })).toBeNull(); // cond is last, no next
  });

  it("when condition passes, falls through normally", () => {
    const cond: ProtocolStep = {
      id: "x",
      instruction: "z",
      condition: { field: "v", operator: "equals", value: 1 },
      elseStep: "skip",
    };
    const localSteps = [...steps, cond];
    expect(resolveNextStep(cond, localSteps, { v: 1 })).toBeNull(); // x is last, no next
  });
});

describe("dryRunProtocol", () => {
  const proto: Protocol = {
    name: "test",
    description: "",
    triggers: [],
    steps: [
      { id: "a", instruction: "always", suggestedTools: [{ tool: "tool_a", args: {} }] },
      {
        id: "b",
        instruction: "conditional",
        condition: { field: "go", operator: "equals", value: true },
        suggestedTools: [{ tool: "tool_b", args: {} }],
        requiresUserAction: true,
      },
      { id: "c", instruction: "user-step", requiresUserAction: true },
    ],
    rules: [],
    learnablePreferences: [],
  };

  it("counts steps, user-action steps, and conditional steps", () => {
    const r = dryRunProtocol(proto, { go: true });
    expect(r.totalSteps).toBe(3);
    expect(r.conditionalSteps).toBe(1);
    expect(r.userActionSteps).toBe(2);
  });

  it("when condition fails, marks the step instruction as skipped and zeros its tools", () => {
    const r = dryRunProtocol(proto, { go: false });
    const skipped = r.steps.find(s => s.id === "b")!;
    expect(skipped.instruction).toContain("[SKIPPED");
    expect(skipped.wouldExecuteTools).toEqual([]);
    expect(skipped.requiresUserAction).toBe(false);
  });

  it("conditionSummary is set when a condition is present", () => {
    const r = dryRunProtocol(proto, { go: true });
    expect(r.steps.find(s => s.id === "b")!.conditionSummary).toContain("equals");
  });
});
