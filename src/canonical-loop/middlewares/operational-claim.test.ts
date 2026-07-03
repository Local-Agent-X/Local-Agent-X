import { describe, expect, it } from "vitest";
import type { CanonicalLoopContext } from "./types.js";
import { operationalClaimMiddleware } from "./operational-claim.js";

let counter = 0;
function ctx(over: Partial<CanonicalLoopContext> = {}): CanonicalLoopContext {
  return {
    op: { id: `operational-${counter++}`, type: "chat_turn", lane: "interactive" },
    turnIdx: 0,
    toolCalls: [],
    assistantContent: "The kernel applied a permanent block because an old event raised the threat level.",
    toolsCalledThisOp: new Set(),
    attemptedToolsThisOp: new Set(),
    ...over,
  } as CanonicalLoopContext;
}

describe("operational-claim middleware", () => {
  it("nudges and marks the false answer retractable", async () => {
    const result = await operationalClaimMiddleware.afterModelCall!(ctx());
    expect(result).toMatchObject({
      kind: "nudge",
      reason: "unsupported-operational-claim",
    });
  });

  it("continues after fresh inspection evidence", async () => {
    const result = await operationalClaimMiddleware.afterModelCall!(ctx({
      toolsCalledThisOp: new Set(["read_my_logs"]),
    }));
    expect(result).toEqual({ kind: "continue" });
  });

  it("lets an in-flight diagnostic tool execute before judging the final answer", async () => {
    const result = await operationalClaimMiddleware.afterModelCall!(ctx({
      toolCalls: [{ toolCallId: "call-1", tool: "read_my_logs", args: {} }],
    }));
    expect(result).toEqual({ kind: "continue" });
  });

  it("fires at most once per op", async () => {
    const c = ctx();
    expect((await operationalClaimMiddleware.afterModelCall!(c)).kind).toBe("nudge");
    expect(await operationalClaimMiddleware.afterModelCall!(c)).toEqual({ kind: "continue" });
  });
});
