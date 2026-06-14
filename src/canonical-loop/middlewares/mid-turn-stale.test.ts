import { describe, it, expect } from "vitest";
import { midTurnStaleMiddleware } from "./mid-turn-stale.js";
import { _resetMiddlewareStates } from "./state.js";
import type { CanonicalLoopContext } from "./types.js";

let _op = 0;
function opId(): string { return `op-mts-test-${++_op}`; }

function ctxFor(
  op: string,
  over: Partial<CanonicalLoopContext>,
): CanonicalLoopContext {
  return {
    op: { id: op, lane: "interactive" },
    turnIdx: 6,
    committingToolsThisOp: new Set<string>(),
    evidenceHistory: [],
    toolResults: [],
    ...over,
  } as unknown as CanonicalLoopContext;
}

const browserOk = () => ({ toolName: "browser", content: "clicked", status: "ok" as const, toolCallId: "tc" });

function recordTurn(op: string, results: Array<{ toolName: string; content: string; status: "ok" | "error" | "cancelled"; toolCallId: string }>) {
  return midTurnStaleMiddleware.afterToolExecution!(ctxFor(op, { toolResults: results }));
}

describe("mid-turn-stale — monotonous-action branch", () => {
  it("nudges once when one non-committing action tool dominates the window with no commit", async () => {
    _resetMiddlewareStates();
    const op = opId();
    // Growing evidence (so the flat-evidence branch can't fire) + browser-only turns.
    for (let i = 0; i < STALE_WINDOW(); i++) await recordTurn(op, [browserOk()]);
    const r = await midTurnStaleMiddleware.beforeTurn!(ctxFor(op, { evidenceHistory: [3, 5, 7] }));
    expect(r.kind).toBe("nudge");
    expect((r as { reason: string }).reason).toBe("no-progress-spin");
    expect((r as { message: string }).message).toContain("browser");

    // One-shot: a second eval doesn't re-nudge.
    const r2 = await midTurnStaleMiddleware.beforeTurn!(ctxFor(op, { evidenceHistory: [3, 5, 7] }));
    expect(r2.kind).toBe("continue");
  });

  it("does NOT fire once a committing tool has run this op", async () => {
    _resetMiddlewareStates();
    const op = opId();
    for (let i = 0; i < STALE_WINDOW(); i++) await recordTurn(op, [browserOk()]);
    const r = await midTurnStaleMiddleware.beforeTurn!(
      ctxFor(op, { evidenceHistory: [3, 5, 7], committingToolsThisOp: new Set(["write"]) }),
    );
    expect(r.kind).toBe("continue");
  });

  it("a mixed-tool turn breaks the monotony streak", async () => {
    _resetMiddlewareStates();
    const op = opId();
    await recordTurn(op, [browserOk()]);
    await recordTurn(op, [browserOk(), { toolName: "read", content: "x", status: "ok", toolCallId: "tc2" }]);
    await recordTurn(op, [browserOk()]);
    const r = await midTurnStaleMiddleware.beforeTurn!(ctxFor(op, { evidenceHistory: [3, 5, 7] }));
    expect(r.kind).toBe("continue");
  });

  it("does not fire before MIN_ITERATION turns", async () => {
    _resetMiddlewareStates();
    const op = opId();
    for (let i = 0; i < STALE_WINDOW(); i++) await recordTurn(op, [browserOk()]);
    const r = await midTurnStaleMiddleware.beforeTurn!(ctxFor(op, { turnIdx: 2, evidenceHistory: [3, 5, 7] }));
    expect(r.kind).toBe("continue");
  });
});

// STALE_WINDOW is a module-internal const; mirror it here so the test reads the
// same threshold without exporting an internal.
function STALE_WINDOW(): number { return 3; }
