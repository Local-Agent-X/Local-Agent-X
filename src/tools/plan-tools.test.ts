// Plan-mode tools vs the ENFORCED session flag: the model may enter/exit its
// own soft plan mode, but while the user's Plan toggle is on, exit_plan_mode
// must refuse and isPlanMode must read true regardless of the soft flag —
// otherwise the model could lift the user's standing mandate itself.
import { describe, it, expect, afterEach } from "vitest";
import { planTools, isPlanMode, clearSoftPlanMode } from "./plan-tools.js";
import { setEnforcedPlanMode, _resetEnforcedPlanMode } from "../canonical-loop/instruction-ledger/plan-mode.js";

const enter = planTools.find((t) => t.name === "enter_plan_mode")!;
const exit = planTools.find((t) => t.name === "exit_plan_mode")!;

afterEach(() => {
  _resetEnforcedPlanMode();
  clearSoftPlanMode("s1");
});

describe("soft plan mode (model-driven) — unchanged behavior", () => {
  it("enter → isPlanMode true; exit → false", async () => {
    await enter.execute({ _sessionId: "s1" });
    expect(isPlanMode("s1")).toBe(true);
    const res = await exit.execute({ _sessionId: "s1" });
    expect(res.content).toContain("deactivated");
    expect(isPlanMode("s1")).toBe(false);
  });
});

describe("enforced plan mode (user's Plan toggle)", () => {
  it("isPlanMode reads true from the enforced flag alone", () => {
    setEnforcedPlanMode("s1", true);
    expect(isPlanMode("s1")).toBe(true);
  });

  it("exit_plan_mode REFUSES while enforced — the model cannot lift the mandate", async () => {
    setEnforcedPlanMode("s1", true);
    const res = await exit.execute({ _sessionId: "s1" });
    expect(res.content).toContain("only the user can turn it off");
    expect(isPlanMode("s1")).toBe(true);
  });

  it("exit_plan_mode while enforced does not clobber the soft flag either", async () => {
    await enter.execute({ _sessionId: "s1" });
    setEnforcedPlanMode("s1", true);
    await exit.execute({ _sessionId: "s1" });
    // User lifts enforcement (the approval event, which also clears soft):
    setEnforcedPlanMode("s1", false);
    clearSoftPlanMode("s1");
    expect(isPlanMode("s1")).toBe(false);
  });
});
