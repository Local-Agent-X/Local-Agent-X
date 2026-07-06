// Plan-mode tools vs the ENFORCED session flag: the model may enter/exit its
// own soft plan mode, but while the user's Plan toggle is on, exit_plan_mode
// must not exit directly — it raises an ApprovalManager card carrying the
// model's plan summary, and only the USER's approval (or the Plan toggle)
// ends the mode. Decline/timeout keeps the mandate standing.
import { describe, it, expect, afterEach } from "vitest";
import { planTools, isPlanMode, clearSoftPlanMode } from "./plan-tools.js";
import { setEnforcedPlanMode, isEnforcedPlanMode, _resetEnforcedPlanMode } from "../canonical-loop/instruction-ledger/plan-mode.js";
import { getApprovalManager } from "../approval-manager.js";
import type { ServerEvent } from "../types.js";

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

  it("exit with no interactive channel (no _onEvent) refuses and keeps the mode", async () => {
    setEnforcedPlanMode("s1", true);
    const res = await exit.execute({ _sessionId: "s1", summary: "a plan" });
    expect(res.content).toContain("no interactive user");
    expect(isEnforcedPlanMode("s1")).toBe(true);
  });

  it("exit with no summary asks for one instead of raising a card", async () => {
    setEnforcedPlanMode("s1", true);
    const events: ServerEvent[] = [];
    const res = await exit.execute({ _sessionId: "s1", _onEvent: (e: ServerEvent) => events.push(e) });
    expect(res.content).toContain("WITH a `summary`");
    expect(events.filter((e) => e.type === "approval_requested")).toHaveLength(0);
    expect(isEnforcedPlanMode("s1")).toBe(true);
  });

  it("APPROVED plan ends the mode: card carries the summary, plan_mode_changed is emitted", async () => {
    setEnforcedPlanMode("s1", true);
    const events: ServerEvent[] = [];
    const pending = exit.execute({
      _sessionId: "s1",
      summary: "Refactor the parser into two modules",
      _onEvent: (e: ServerEvent) => events.push(e),
    });
    // The card is up and shows the concrete plan, not a bare mode flip.
    await new Promise((r) => setTimeout(r, 10));
    const card = events.find((e) => e.type === "approval_requested") as Extract<ServerEvent, { type: "approval_requested" }>;
    expect(card).toBeDefined();
    expect(card.context).toContain("Refactor the parser into two modules");
    expect(isEnforcedPlanMode("s1")).toBe(true); // still on while the card is pending

    getApprovalManager().resolveApproval(card.approvalId, true);
    const res = await pending;
    expect(res.content).toContain("Plan approved");
    expect(isEnforcedPlanMode("s1")).toBe(false);
    expect(isPlanMode("s1")).toBe(false); // soft flag cleared with the approval too
    expect(events.some((e) => e.type === "plan_mode_changed" && e.enforced === false)).toBe(true);
  });

  it("a RE-CALL while a card is pending returns wait-guidance instead of a second card", async () => {
    setEnforcedPlanMode("s1", true);
    const events: ServerEvent[] = [];
    const emit = (e: ServerEvent) => events.push(e);
    const pending = exit.execute({ _sessionId: "s1", summary: "plan v1", _onEvent: emit });
    await new Promise((r) => setTimeout(r, 10));

    // Model retries with a REPHRASED summary — different args would defeat the
    // manager's exact-args coalescing, so the tool-level guard must catch it.
    const retry = await exit.execute({ _sessionId: "s1", summary: "plan v1, slightly reworded", _onEvent: emit });
    expect(retry.content).toContain("ALREADY awaiting");
    expect(events.filter((e) => e.type === "approval_requested")).toHaveLength(1);

    const card = events.find((e) => e.type === "approval_requested") as Extract<ServerEvent, { type: "approval_requested" }>;
    getApprovalManager().resolveApproval(card.approvalId, false);
    await pending;
  });

  it("a new USER MESSAGE (denyPendingForSession) resolves the wait as denied and keeps the mode", async () => {
    setEnforcedPlanMode("s1", true);
    const events: ServerEvent[] = [];
    const pending = exit.execute({ _sessionId: "s1", summary: "a plan", _onEvent: (e: ServerEvent) => events.push(e) });
    await new Promise((r) => setTimeout(r, 10));

    expect(getApprovalManager().denyPendingForSession("s1")).toBe(1);
    const res = await pending;
    expect(res.content).toContain("did NOT approve");
    expect(isEnforcedPlanMode("s1")).toBe(true);
  });

  it("DECLINED plan keeps the mode standing", async () => {
    setEnforcedPlanMode("s1", true);
    const events: ServerEvent[] = [];
    const pending = exit.execute({
      _sessionId: "s1",
      summary: "Delete the tests",
      _onEvent: (e: ServerEvent) => events.push(e),
    });
    await new Promise((r) => setTimeout(r, 10));
    const card = events.find((e) => e.type === "approval_requested") as Extract<ServerEvent, { type: "approval_requested" }>;
    getApprovalManager().resolveApproval(card.approvalId, false);
    const res = await pending;
    expect(res.content).toContain("did NOT approve");
    expect(isEnforcedPlanMode("s1")).toBe(true);
    expect(events.some((e) => e.type === "plan_mode_changed")).toBe(false);
  });
});
