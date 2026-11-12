import { describe, expect, it, vi } from "vitest";
import type { OpToolFailure } from "../../canonical-loop/public/op-tool-failures.js";
import { backfillToolFailures, type FailureBackfillDeps } from "./failure-backfill.js";

const NOW = Date.parse("2026-11-11T18:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function failure(toolCallId: string, agoMs: number, over: Partial<OpToolFailure> = {}): OpToolFailure {
  return { toolCallId, tool: "bash", status: "error", reason: "python3: command not found", signature: "sig-python", at: NOW - agoMs, ...over };
}

function deps(over: Partial<FailureBackfillDeps> = {}): FailureBackfillDeps & { written: unknown[]; marked: number } {
  const written: unknown[] = [];
  const state = { marked: 0 };
  return {
    done: () => false,
    markDone: () => { state.marked++; },
    recentOps: () => [],
    failuresOf: () => [],
    knownCallIds: async () => new Set<string>(),
    write: (event) => { written.push(event); },
    now: () => NOW,
    ...over,
    written,
    get marked() { return state.marked; },
  };
}

describe("backfillToolFailures", () => {
  it("writes a past run's failures with the time they happened and the run to open", async () => {
    const d = deps({
      recentOps: () => [{ id: "op_1", sessionId: "chat-1", createdAt: new Date(NOW - 2 * DAY).toISOString() }],
      failuresOf: () => [failure("c1", 2 * DAY), failure("c2", 2 * DAY, { tool: "office", action: "read", status: "blocked", layer: "security", signature: "sig-office" })],
    });
    expect(await backfillToolFailures(d)).toEqual({ ops: 1, written: 2 });
    expect(d.written).toEqual([
      {
        ts: new Date(NOW - 2 * DAY).toISOString(), tool: "bash", status: "error", callContext: "backfill", sessionId: "chat-1",
        failure: { signature: "sig-python", reason: "python3: command not found", opId: "op_1", toolCallId: "c1" },
      },
      {
        ts: new Date(NOW - 2 * DAY).toISOString(), tool: "office", status: "blocked", callContext: "backfill", sessionId: "chat-1", action: "read",
        failure: { signature: "sig-office", reason: "python3: command not found", opId: "op_1", toolCallId: "c2", layer: "security" },
      },
    ]);
    expect(d.marked).toBe(1);
  });

  it("runs once", async () => {
    const recentOps = vi.fn(() => []);
    expect(await backfillToolFailures(deps({ done: () => true, recentOps }))).toBeNull();
    expect(recentOps).not.toHaveBeenCalled();
  });

  it("never writes a call the log already identifies, so a second pass adds nothing", async () => {
    const d = deps({
      recentOps: () => [
        { id: "op_1", sessionId: "chat-1", createdAt: new Date(NOW - DAY).toISOString() },
        // The same call seen through a second run (a retried op).
        { id: "op_2", sessionId: "chat-1", createdAt: new Date(NOW - DAY).toISOString() },
      ],
      failuresOf: () => [failure("live", DAY), failure("past", DAY)],
      knownCallIds: async () => new Set(["live"]),
    });
    expect(await backfillToolFailures(d)).toEqual({ ops: 2, written: 1 });
  });

  it("reads nothing older than the window, and survives a run it cannot read", async () => {
    const failuresOf = vi.fn((opId: string) => {
      if (opId === "broken") throw new Error("torn file");
      return [failure(`c-${opId}`, DAY)];
    });
    const d = deps({
      recentOps: () => [
        { id: "old", sessionId: "chat-1", createdAt: new Date(NOW - 20 * DAY).toISOString() },
        { id: "broken", sessionId: "chat-2", createdAt: new Date(NOW - DAY).toISOString() },
        { id: "numeric", createdAt: NOW - DAY },
      ],
      failuresOf,
    });
    expect(await backfillToolFailures(d)).toEqual({ ops: 2, written: 1 });
    expect(failuresOf).not.toHaveBeenCalledWith("old");
    // A run with no chat on record is counted under its own id.
    expect(d.written[0]).toMatchObject({ sessionId: "numeric" });
    expect(d.marked).toBe(1);
  });
});
