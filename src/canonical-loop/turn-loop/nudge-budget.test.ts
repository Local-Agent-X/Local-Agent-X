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
    // Fifth guard on the same chat op gets nothing, whoever it is.
    expect(consumeNudgeBudget("op-1", fire("loop-detection"))).toBe(false);
    expect(consumeNudgeBudget("op-1", fire("earned-done"))).toBe(false);
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
