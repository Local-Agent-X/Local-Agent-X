/**
 * Lane-policy wiring for the loop-detection middleware. This is the layer the
 * grok `ls workspace/apps/` spin slipped through: the middleware was gated to
 * non-interactive lanes, so a user chat had no auto loop-breaker at all. These
 * lock that it now runs on interactive (nudge-only) while workers still abort.
 */

import { describe, it, expect } from "vitest";
import { loopDetectionMiddleware } from "./loop-detection.js";
import type { CanonicalLoopContext } from "./types.js";

let _op = 0;
const opId = () => `op-loop-test-${++_op}`;
const lsCall = { tool: "bash", args: { cmd: "ls workspace/apps/" } };

function ctxFor(op: string, lane: string, results: { content: string }[]): CanonicalLoopContext {
  return {
    op: { id: op, lane },
    model: "grok-4.3",
    toolCalls: [lsCall],
    toolResults: results,
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

  it("build (worker): hard-aborts the same spin", async () => {
    const kinds = await spin(opId(), "build", 6, () => "identical");
    expect(kinds).toContain("abort");
  });

  it("interactive: leaves a changing-result repeat alone", async () => {
    const kinds = await spin(opId(), "interactive", 6, i => "output-" + i);
    expect(kinds.every(k => k === "continue")).toBe(true);
  });
});
