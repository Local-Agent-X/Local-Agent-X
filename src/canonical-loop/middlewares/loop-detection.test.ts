/**
 * Lane-policy wiring for the loop-detection middleware. This is the layer the
 * grok `ls workspace/apps/` spin slipped through: the middleware was gated to
 * non-interactive lanes, so a user chat had no auto loop-breaker at all. These
 * lock that it now runs on interactive (nudge-only) while workers pivot.
 */

import { describe, it, expect } from "vitest";
import { loopDetectionMiddleware } from "./loop-detection.js";
import type { CanonicalLoopContext } from "./types.js";

let _op = 0;
const opId = () => `op-loop-test-${++_op}`;
const lsCall = { tool: "bash", args: { cmd: "ls workspace/apps/" } };

function ctxFor(
  op: string,
  lane: string,
  results: { content: string; status?: "ok" }[],
  call: { toolCallId?: string; tool: string; args: unknown } = lsCall,
): CanonicalLoopContext {
  return {
    op: { id: op, lane },
    model: "grok-4.3",
    toolCalls: [call],
    toolResults: results,
    turnIdx: 1,
    toolNames: new Set<string>(),
    onEvent: () => {},
  } as unknown as CanonicalLoopContext;
}

// Drive N turns of the same `ls` call through both hooks, as the loop does.
async function spin(op: string, lane: string, turns: number, result: (i: number) => string) {
  const kinds: string[] = [];
  for (let i = 0; i < turns; i++) {
    const ctx = ctxFor(op, lane, [{ content: result(i) }]);
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
      const ctx = ctxFor(op, "build", [{ content: "identical", status: "ok" }]);
      expect((await loopDetectionMiddleware.afterModelCall!(ctx)).kind).toBe("continue");
      completed = await loopDetectionMiddleware.afterToolExecution!(ctx);
    }
    expect(completed.kind).toBe("nudge");
    expect(completed.reason).toBe("strategy-pivot");
    expect((completed as { metadata?: { strategyPivot?: { strategyId: string } } }).metadata?.strategyPivot?.strategyId)
      .toBe("evidence-synthesis");
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
    });
    const verdict = await loopDetectionMiddleware.afterModelCall!(repeated);
    expect(verdict.kind).toBe("nudge");
    expect((verdict as { skipToolDispatch?: boolean }).skipToolDispatch).toBe(true);
    expect(repeated.toolCalls).toHaveLength(0);
  });
});
