/**
 * Regression guard: the dead-end detector must run on interactive chat.
 *
 * It used to be gated `when: isWorkerOp`, so a weak model spinning on empty
 * searches in normal chat never got the "stop, pick a different tool" nudge —
 * the single most useful recovery hint was dark in the main lane. The gate is
 * removed because dead-end only ever nudges (never aborts), so it's safe on
 * interactive.
 */
import { describe, expect, it } from "vitest";

import { deadEndMiddleware } from "../src/canonical-loop/middlewares/dead-end.js";
import type {
  CanonicalLoopContext,
  CanonicalToolResultView,
} from "../src/canonical-loop/middlewares/types.js";

function interactiveCtx(opId: string, results: CanonicalToolResultView[]): CanonicalLoopContext {
  return {
    op: { id: opId, lane: "interactive" } as CanonicalLoopContext["op"],
    turnIdx: 0,
    userMessage: "find the thing",
    provider: "xai",
    model: "grok-4",
    tools: [],
    toolNames: new Set(),
    assistantContent: "",
    toolCalls: [],
    toolResults: results,
    toolsCalledThisOp: new Set(),
    committingToolsThisOp: new Set(),
    evidenceHistory: [],
  };
}

const empty = (toolName: string): CanonicalToolResultView => ({
  toolName,
  toolCallId: "tc",
  content: "No matches found.",
  status: "ok",
});

describe("deadEndMiddleware — active on interactive lane", () => {
  it("is not gated off for interactive ops", () => {
    const ctx = interactiveCtx("op-gate", [empty("grep")]);
    const active = !deadEndMiddleware.when || deadEndMiddleware.when(ctx);
    expect(active).toBe(true);
  });

  it("nudges after 3 empty results in a row on an interactive op", async () => {
    const opId = "op-spin";
    const r1 = await deadEndMiddleware.afterToolExecution!(interactiveCtx(opId, [empty("grep")]));
    const r2 = await deadEndMiddleware.afterToolExecution!(interactiveCtx(opId, [empty("glob")]));
    const r3 = await deadEndMiddleware.afterToolExecution!(interactiveCtx(opId, [empty("grep")]));

    expect(r1.kind).toBe("continue");
    expect(r2.kind).toBe("continue");
    expect(r3.kind).toBe("nudge");
    if (r3.kind === "nudge") expect(r3.message).toMatch(/different tool|reconsider/i);
  });
});
