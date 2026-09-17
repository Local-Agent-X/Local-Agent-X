import { describe, it, expect, beforeEach, vi } from "vitest";

const opType = vi.hoisted(() => ({ value: "chat_turn" as string | undefined }));
vi.mock("../../ops/op-store.js", () => ({
  readOp: vi.fn(() => (opType.value ? { id: "op-1", type: opType.value } : null)),
}));

const appended = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("../store.js", () => ({
  appendOpMessage: vi.fn((row: unknown) => { appended.rows.push(row); }),
  readOpMessages: vi.fn(() => []),
  readOpTurn: vi.fn(() => null),
}));
vi.mock("../event-emitter.js", () => ({ emit: vi.fn(), emitErrorOnce: vi.fn(() => true) }));
vi.mock("./guard-fire.js", () => ({
  recordGuardFire: vi.fn(),
  firedResultFire: vi.fn(),
  directiveFire: vi.fn(),
}));

const { consumeNudgeBudget, nudgeBudgetFor, nudgesSpent } = await import("./nudge-budget.js");
const { appendNudgeAsUserMessage } = await import("./nudges.js");
const { _resetMiddlewareStates } = await import("../middlewares/state.js");

const fire = (name: string, reason = name) => ({ name, reason, outcome: "nudge" as const });

beforeEach(() => {
  _resetMiddlewareStates();
  appended.rows = [];
  opType.value = "chat_turn";
});

describe("nudge budget", () => {
  it("gives an interactive chat the smallest budget — a person is there to redirect it", () => {
    expect(nudgeBudgetFor("chat_turn")).toBe(4);
    expect(nudgeBudgetFor("app_build")).toBeGreaterThan(nudgeBudgetFor("chat_turn"));
    expect(nudgeBudgetFor("agent_spawn")).toBe(8);
    expect(nudgeBudgetFor(undefined)).toBe(8);
  });

  it("is SHARED: different guards spend the same budget, and it runs out", () => {
    const guards = ["cleanup-verify", "verify-gate", "open-steps", "tool-failure-summary"];
    for (const g of guards) expect(consumeNudgeBudget("op-1", fire(g))).toBe(true);
    expect(nudgesSpent("op-1")).toBe(4);
    // Fifth guard on the same chat op gets nothing — unless it is one of the
    // self-bounded guards below.
    expect(consumeNudgeBudget("op-1", fire("repeat-failure"))).toBe(false);
    expect(consumeNudgeBudget("op-1", fire("earned-done"))).toBe(false);
  });

  // muse, grade-school, 2026-09-17: two "a tool call failed" notices, the 25%
  // rung and one more failure notice spent the chat pool, the 50% rung was
  // refused, and the op wandered 60+ turns unsteered. The guards that decide
  // steering has stopped working are bounded by construction and must speak.
  it("never starves the self-bounded guards that end a stuck op", () => {
    for (let i = 0; i < 4; i++) consumeNudgeBudget("op-1", fire("tool-failure-summary"));
    expect(consumeNudgeBudget("op-1", fire("tool-failure-summary"))).toBe(false);
    expect(consumeNudgeBudget("op-1", fire("budget-ladder"))).toBe(true);
    expect(consumeNudgeBudget("op-1", fire("budget-ladder", "budget-ladder-dry"))).toBe(true);
    expect(consumeNudgeBudget("op-1", fire("loop-detection"))).toBe(true);
    expect(nudgesSpent("op-1"), "and they do not draw on the pool").toBe(4);
  });

  it("does not let a self-bounded guard spend the pool the others need", () => {
    for (let i = 0; i < 3; i++) consumeNudgeBudget("op-1", fire("budget-ladder"));
    expect(nudgesSpent("op-1")).toBe(0);
    expect(consumeNudgeBudget("op-1", fire("verify-gate"))).toBe(true);
  });

  it("is per-op: a fresh op starts with a full budget", () => {
    for (let i = 0; i < 4; i++) consumeNudgeBudget("op-1", fire("verify-gate"));
    expect(consumeNudgeBudget("op-1", fire("verify-gate"))).toBe(false);
    expect(consumeNudgeBudget("op-2", fire("verify-gate"))).toBe(true);
  });

  it("never charges a provider-error resume — that steers nothing", () => {
    for (let i = 0; i < 10; i++) {
      expect(consumeNudgeBudget("op-1", { name: "adapter-throw-recovery", reason: "adapter-retry", outcome: "nudge" })).toBe(true);
    }
    expect(nudgesSpent("op-1")).toBe(0);
    expect(consumeNudgeBudget("op-1", fire("verify-gate"))).toBe(true);
  });

  it("a build op keeps enough budget for its verify gates to retry", () => {
    opType.value = "app_build";
    for (const g of ["render-verify", "render-verify", "build-verify", "build-verify", "spec-probe", "design-verify"]) {
      expect(consumeNudgeBudget("op-b", fire(g))).toBe(true);
    }
  });
});

  // muse, wordy, 2026-09-17: four "a tool call failed" notices spent the chat
  // pool; the spec audit then found 2 unmet requirements and its nudge was
  // refused, so the op ended one failing test short with the verdict in hand.
  it("keeps a small pool for the guards that speak from evidence", () => {
    for (const g of ["tool-failure-summary", "open-steps", "cleanup-verify", "tool-failure-summary"]) {
      expect(consumeNudgeBudget("op-1", fire(g))).toBe(true);
    }
    expect(consumeNudgeBudget("op-1", fire("open-steps")), "shared pool is gone").toBe(false);
    expect(consumeNudgeBudget("op-1", fire("spec-audit"))).toBe(true);
    expect(consumeNudgeBudget("op-1", fire("build-verify"))).toBe(true);
    // Their own pool is bounded too: a third queues for the spent shared pool.
    expect(consumeNudgeBudget("op-1", fire("regression-audit"))).toBe(false);
    expect(nudgesSpent("op-1"), "and their pool is not the shared one").toBe(4);
  });

  it("spends the verdict pool before the shared one, so chatter still gets its 4", () => {
    expect(consumeNudgeBudget("op-1", fire("spec-audit"))).toBe(true);
    expect(consumeNudgeBudget("op-1", fire("spec-probe"))).toBe(true);
    expect(nudgesSpent("op-1")).toBe(0);
    for (const g of ["tool-failure-summary", "open-steps", "cleanup-verify", "verify-gate"]) {
      expect(consumeNudgeBudget("op-1", fire(g))).toBe(true);
    }
  });

describe("appendNudgeAsUserMessage", () => {
  it("writes nothing once the budget is gone", () => {
    for (let i = 0; i < 4; i++) {
      expect(appendNudgeAsUserMessage("op-1", i + 1, `nudge ${i}`, fire("verify-gate"))).toBe(true);
    }
    expect(appended.rows).toHaveLength(4);
    expect(appendNudgeAsUserMessage("op-1", 5, "one too many", fire("verify-gate"))).toBe(false);
    expect(appended.rows).toHaveLength(4);
  });
});