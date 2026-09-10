/**
 * Lane-policy wiring for the loop-detection middleware. This is the layer the
 * grok `ls workspace/apps/` spin slipped through: the middleware was gated to
 * non-interactive lanes, so a user chat had no auto loop-breaker at all. These
 * lock that it now runs on interactive (nudge-only) while workers pivot.
 */

import { describe, it, expect } from "vitest";
import { loopDetectionMiddleware } from "./loop-detection.js";
import type { CanonicalLoopContext } from "./types.js";
import { makeCanonicalLoopContext } from "./ctx.test-helper.js";
import { getMiddlewareState } from "./state.js";
import { createLoopState, type LoopState } from "../../agent-guards/index.js";

let _op = 0;
const opId = () => `op-loop-test-${++_op}`;
const lsCall = { tool: "bash", args: { cmd: "ls workspace/apps/" } };

function ctxFor(
  op: string,
  lane: string,
  results: { content: string; status?: "ok" }[],
  call: { toolCallId?: string; tool: string; args: unknown } = lsCall,
  // Real turns have distinct indices; the worker-lane pivot ceiling offers at
  // most one pivot per turn, so a fixture replaying N turns must number them.
  turnIdx = 1,
  // loopGuardTier: grok-4.3 → strong; a 32B local model → medium.
  model = "grok-4.3",
): CanonicalLoopContext {
  // The ids and tool names below are filled in to satisfy the real ToolCall /
  // CanonicalToolResultView shapes, which the old blanket
  // `as unknown as CanonicalLoopContext` let this fixture skip. Neither is read
  // here — noteToolResults keys on content + status only.
  const toolCallId = call.toolCallId ?? "tc";
  return makeCanonicalLoopContext({
    op: { id: op, lane },
    model,
    toolCalls: [{ ...call, toolCallId }],
    toolResults: results.map((r, i) => ({
      toolName: call.tool,
      toolCallId: `${toolCallId}-${i}`,
      content: r.content,
      status: r.status,
    })),
    turnIdx,
    toolNames: new Set<string>(),
    onEvent: () => {},
  });
}

// Drive N turns of the same `ls` call through both hooks, as the loop does.
async function spin(op: string, lane: string, turns: number, result: (i: number) => string) {
  const kinds: string[] = [];
  for (let i = 0; i < turns; i++) {
    const ctx = ctxFor(op, lane, [{ content: result(i) }], lsCall, i + 1);
    kinds.push((await loopDetectionMiddleware.afterModelCall!(ctx)).kind);
    await loopDetectionMiddleware.afterToolExecution!(ctx);
  }
  return kinds;
}

describe("loop-detection middleware — lane policy", () => {
  it("interactive: nudges a same-call/same-result spin but never aborts the turn", async () => {
    const kinds = await spin(opId(), "interactive", 6, () => "identical");
    expect(kinds).toContain("nudge");
    expect(kinds).not.toContain("abort");
  });

  it("build (worker): arms after completed evidence and pivots before another model call", async () => {
    const op = opId();
    let completed: { kind: string; [key: string]: unknown } = { kind: "continue" };
    for (let i = 0; i < 3; i++) {
      const ctx = ctxFor(op, "build", [{ content: "identical", status: "ok" }], lsCall, i + 1);
      expect((await loopDetectionMiddleware.afterModelCall!(ctx)).kind).toBe("continue");
      completed = await loopDetectionMiddleware.afterToolExecution!(ctx);
    }
    expect(completed.kind).toBe("nudge");
    expect(completed.reason).toBe("strategy-pivot");
    expect((completed as { metadata?: { strategyPivot?: { strategyId: string } } }).metadata?.strategyPivot?.strategyId)
      .toBe("theory-falsification");
    expect((await loopDetectionMiddleware.beforeTurn!(ctxFor(op, "build", []))).kind).toBe("continue");
  });

  it("interactive: leaves a changing-result repeat alone", async () => {
    const kinds = await spin(opId(), "interactive", 6, i => "output-" + i);
    expect(kinds.every(k => k === "continue")).toBe(true);
  });

  it("worker blocks a repeated committing key before dispatch despite a changing acknowledgement", async () => {
    const op = opId();
    const firstCall = {
      toolCallId: "calendar-1",
      tool: "calendar_create_event",
      args: { title: "Review", when: "tomorrow" },
    };
    const first = ctxFor(op, "build", [{ content: "created-id-1", status: "ok" }], firstCall);
    expect((await loopDetectionMiddleware.afterModelCall!(first)).kind).toBe("continue");
    expect((await loopDetectionMiddleware.afterToolExecution!(first)).kind).toBe("continue");

    const repeated = ctxFor(op, "build", [{ content: "created-id-2", status: "ok" }], {
      ...firstCall,
      toolCallId: "calendar-2",
    }, 2);
    const verdict = await loopDetectionMiddleware.afterModelCall!(repeated);
    expect(verdict.kind).toBe("nudge");
    expect((verdict as { skipToolDispatch?: boolean }).skipToolDispatch).toBe(true);
    expect(repeated.toolCalls).toHaveLength(0);
  });
});

// One pivot per turn, whichever detector armed it. The ceiling guard in
// afterToolExecution compares `lastPivotTurn` to the turn; a NON-cycle pivot
// must stamp it too, or a pivot offered at beforeTurn is followed by a second
// one from the post-dispatch re-arm in the same turn (the reviewer's surviving
// mutant: "non-cycle pivots stop stamping lastPivotTurn").
describe("loop-detection middleware — at most one pivot per turn, non-cycle pivots included", () => {
  it("a non-cycle pivot offered at beforeTurn is not followed by a second offer from afterToolExecution", async () => {
    const op = opId();
    const poll = { toolCallId: "poll", tool: "http_request", args: { url: "https://x/jobs/1" } };
    const pending = '{"status":"pending"}';
    // Turn 1: first sighting of the result — novel, nothing arms.
    const t1 = ctxFor(op, "build", [{ content: pending, status: "ok" }], poll, 1, "qwen3:32b");
    expect((await loopDetectionMiddleware.afterModelCall!(t1)).kind).toBe("continue");
    expect((await loopDetectionMiddleware.afterToolExecution!(t1)).kind).toBe("continue");

    // A non-cycle pivot left pending for the next turn (the shape a re-arm on
    // an already-pivoted turn leaves behind).
    const state = getMiddlewareState<LoopState>(op, "loop-detection", createLoopState);
    state.pendingStrategyPivot = "exact-repeat";
    state.pendingPivotFromCycle = false;

    // Turn 2: beforeTurn offers it; the identical poll result then re-arms
    // exact-repeat (medium tier) in afterToolExecution — same turn, no offer.
    const t2 = ctxFor(op, "build", [{ content: pending, status: "ok" }], poll, 2, "qwen3:32b");
    const offers: string[] = [];
    for (const phase of ["beforeTurn", "afterModelCall", "afterToolExecution"] as const) {
      const verdict = await loopDetectionMiddleware[phase]!(t2);
      expect(verdict.kind).not.toBe("abort");
      if (verdict.kind === "nudge" && verdict.reason === "strategy-pivot") offers.push(phase);
    }
    expect(offers).toEqual(["beforeTurn"]);
    // The re-armed pivot waits for the next turn rather than piling on.
    expect(state.pendingStrategyPivot).not.toBeNull();
    expect((await loopDetectionMiddleware.beforeTurn!(ctxFor(op, "build", [], poll, 3, "qwen3:32b"))).kind).toBe("nudge");
  });
});
