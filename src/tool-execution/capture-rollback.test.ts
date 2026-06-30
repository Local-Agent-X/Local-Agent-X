/**
 * capture-rollback phase gating — the wiring that connects the autonomy
 * profile's "allow-with-rollback" decision to the rollback snapshot.
 *
 * The snapshot mechanics live in autonomy/rollback.ts (tested there). This
 * locks the GATE: capture fires for exactly one decision and is otherwise a
 * no-op, and a capture failure never blocks the tool the profile approved.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted so these exist when the hoisted vi.mock factories below run.
const { getToolDecision, captureRollback } = vi.hoisted(() => ({
  getToolDecision: vi.fn<(tool: string, sessionId?: string) => string>(),
  captureRollback: vi.fn(),
}));

vi.mock("../approval-manager.js", () => ({ getToolDecision }));
vi.mock("../autonomy/rollback.js", () => ({ captureRollback }));

import { captureRollbackPhase } from "./capture-rollback.js";
import { CONTINUE } from "./context.js";
import type { ToolCallContext } from "./context.js";

function ctx(name = "write", args: Record<string, unknown> = { path: "/tmp/x" }): ToolCallContext {
  return {
    tc: { id: "tc-1", name, arguments: JSON.stringify(args) },
    sessionId: "sess-1",
    args,
  } as unknown as ToolCallContext;
}

beforeEach(() => {
  getToolDecision.mockReset();
  captureRollback.mockReset();
  captureRollback.mockReturnValue({
    toolCallId: "tc-1", ts: 0, tool: "write", risk: "workspace-write",
    artifacts: [{ type: "file-backup", original: "/tmp/x", backup: "/tmp/x.bak" }],
  });
});

describe("captureRollbackPhase gating", () => {
  it("captures when the decision is allow-with-rollback", async () => {
    getToolDecision.mockReturnValue("allow-with-rollback");
    const outcome = await captureRollbackPhase(ctx());
    expect(captureRollback).toHaveBeenCalledTimes(1);
    expect(captureRollback).toHaveBeenCalledWith("tc-1", "write", expect.any(String), { path: "/tmp/x" });
    expect(outcome).toEqual(CONTINUE);
  });

  it.each(["allow", "ask", "deny"])(
    "does NOT capture when the decision is %s",
    async (decision) => {
      getToolDecision.mockReturnValue(decision);
      const outcome = await captureRollbackPhase(ctx());
      expect(captureRollback).not.toHaveBeenCalled();
      expect(outcome).toEqual(CONTINUE);
    },
  );

  it("passes the call's own sessionId through to the decision lookup", async () => {
    getToolDecision.mockReturnValue("allow");
    await captureRollbackPhase(ctx());
    expect(getToolDecision).toHaveBeenCalledWith("write", "sess-1");
  });

  it("never blocks the tool when capture throws — capture is best-effort", async () => {
    getToolDecision.mockReturnValue("allow-with-rollback");
    captureRollback.mockImplementation(() => { throw new Error("disk full"); });
    const outcome = await captureRollbackPhase(ctx());
    expect(outcome).toEqual(CONTINUE);
  });
});
