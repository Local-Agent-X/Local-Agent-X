import { describe, it, expect } from "vitest";
import { midTurnStaleMiddleware } from "./mid-turn-stale.js";
import { _resetMiddlewareStates } from "./state.js";
import type { CanonicalLoopContext } from "./types.js";
import { makeCanonicalLoopContext, type CanonicalLoopContextOverrides } from "./ctx.test-helper.js";

let _op = 0;
function opId(): string { return `op-mts-test-${++_op}`; }

function ctxFor(
  op: string,
  over: CanonicalLoopContextOverrides,
): CanonicalLoopContext {
  return makeCanonicalLoopContext({
    op: { id: op, lane: "interactive" },
    turnIdx: 6,
    // Both committing tallies start EMPTY and are set SEPARATELY by the tests
    // below, so each states which question it is exercising. This brake reads
    // only committingToolsThisOp — the RAW name-only tally, which includes the
    // task_* ledger the brake needs and is blind to browser/pdf/http_request,
    // the limit the KNOWN LIMIT cases below pin.
    committingToolsThisOp: new Set<string>(),
    substantiveCommittingToolsThisOp: new Set<string>(),
    evidenceHistory: [],
    toolResults: [],
    ...over,
  });
}

const browserOk = () => ({ toolName: "browser", content: "clicked", status: "ok" as const, toolCallId: "tc" });

function recordTurn(op: string, results: Array<{ toolName: string; content: string; status: "ok" | "error" | "blocked" | "declined" | "timeout" | "cancelled"; toolCallId: string }>) {
  return midTurnStaleMiddleware.afterToolExecution!(ctxFor(op, {
    toolResults: results,
    toolCalls: results.map(result => ({ toolCallId: result.toolCallId, tool: result.toolName, args: { selector: "#stable" } })),
  }));
}

describe("mid-turn-stale — monotonous-action branch", () => {
  it("nudges once when one non-committing action tool dominates the window with no commit", async () => {
    _resetMiddlewareStates();
    const op = opId();
    // Growing evidence (so the flat-evidence branch can't fire) + browser-only turns.
    for (let i = 0; i < STALE_WINDOW(); i++) {
      await recordTurn(op, [{ ...browserOk(), toolCallId: `tc-${i}` }]);
    }
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

  // The abort-safety question, NOT the completion-gate one: task_create was
  // added to the committing registry precisely so this brake would stop
  // aborting turns mid-plan. The completion gates read the SUBSTANTIVE set,
  // which is empty here — reading it from this site re-breaks that fix.
  it("stands down on a planning-only op — planning counts for abort safety", async () => {
    _resetMiddlewareStates();
    const op = opId();
    for (let i = 0; i < STALE_WINDOW(); i++) await recordTurn(op, [browserOk()]);
    const r = await midTurnStaleMiddleware.beforeTurn!(ctxFor(op, {
      evidenceHistory: [3, 5, 7],
      committingToolsThisOp: new Set(["task_create"]),
      substantiveCommittingToolsThisOp: new Set<string>(),
    }));
    expect(r.kind).toBe("continue");
  });

  // The control for the two KNOWN LIMIT cases below: with NOTHING committed,
  // an interactive turn's second strike really does return {kind:"abort"} —
  // this brake IS the circuit-breaker capping a spinning interactive turn, and
  // anything that stands it down costs that cap.
  it("second strike on an interactive lane ABORTS when nothing is committed", async () => {
    _resetMiddlewareStates();
    const op = opId();
    const flat = { evidenceHistory: [4, 4, 4] };
    expect((await midTurnStaleMiddleware.beforeTurn!(ctxFor(op, flat))).kind).toBe("continue");
    const second = await midTurnStaleMiddleware.beforeTurn!(ctxFor(op, flat));
    expect(second.kind).toBe("abort");
  });

  // KNOWN LIMIT: `browser`, `pdf` and `http_request` are the ARG_AWARE_TOOLS —
  // isCommittingTool answers false for all three, so the RAW name-only tally
  // this brake reads stays EMPTY on a turn whose only real work was a "Place
  // order" click, and the second strike aborts on top of the placed order.
  //
  // Pinned as the ACCEPTED cost of not reading an arg-aware tally here. The
  // arg-aware verdict credits `browser` from COMMITTING_BROWSER_ACTION_BUTTONS,
  // a 14-word regex over button text: across 590 real browser calls in ~/.lax
  // it matched 5 times and 4 of those were navigation (`click_text "Purchase
  // Orders"` contains `purchase`), disarming this brake from turn 3 and turn 7
  // of two 20+ turn INTERACTIVE browser ops. Trading a whole op's circuit
  // breaker for a nav-link click is the worse failure. Closing this limit needs
  // a browser verdict page text cannot trip — NOT a swap back to an arg-aware
  // set, which is what these cases go red on.
  it("KNOWN LIMIT: still aborts when the op's only work was a committing browser click", async () => {
    _resetMiddlewareStates();
    const op = opId();
    const clicked = {
      evidenceHistory: [4, 4, 4],
      committingToolsThisOp: new Set<string>(),          // name-only: blind to browser
      substantiveCommittingToolsThisOp: new Set(["browser"]), // arg-aware: saw the click
    };
    expect((await midTurnStaleMiddleware.beforeTurn!(ctxFor(op, clicked))).kind).toBe("continue");
    expect((await midTurnStaleMiddleware.beforeTurn!(ctxFor(op, clicked))).kind).toBe("abort");
  });

  it("KNOWN LIMIT: same for a pdf create and an http_request POST", async () => {
    for (const tool of ["pdf", "http_request"]) {
      _resetMiddlewareStates();
      const op = opId();
      const committed = {
        evidenceHistory: [4, 4, 4],
        committingToolsThisOp: new Set<string>(),
        substantiveCommittingToolsThisOp: new Set([tool]),
      };
      await midTurnStaleMiddleware.beforeTurn!(ctxFor(op, committed));
      const second = await midTurnStaleMiddleware.beforeTurn!(ctxFor(op, committed));
      expect(second.kind, `${tool} is invisible to the name-only tally`).toBe("abort");
    }
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

  // Regression (dispatch-status widening): a blocked browser call used to
  // arrive as "error" and never counted as a success — the widened flavor
  // must not sneak into okTools and keep the monotony streak alive.
  it("widened failure flavors don't count as successful turns", async () => {
    _resetMiddlewareStates();
    const op = opId();
    await recordTurn(op, [browserOk()]);
    await recordTurn(op, [{ toolName: "browser", content: "Refused by policy.", status: "blocked", toolCallId: "tc3" }]);
    await recordTurn(op, [browserOk()]);
    const r = await midTurnStaleMiddleware.beforeTurn!(ctxFor(op, { evidenceHistory: [3, 5, 7] }));
    expect(r.kind).toBe("continue"); // streak broken by the failed (blocked) turn
  });

  it("does not fire before MIN_ITERATION turns", async () => {
    _resetMiddlewareStates();
    const op = opId();
    for (let i = 0; i < STALE_WINDOW(); i++) await recordTurn(op, [browserOk()]);
    const r = await midTurnStaleMiddleware.beforeTurn!(ctxFor(op, { turnIdx: 2, evidenceHistory: [3, 5, 7] }));
    expect(r.kind).toBe("continue");
  });

  it("distinct successful browser page fingerprints break the monotony streak", async () => {
    _resetMiddlewareStates();
    const op = opId();
    for (let i = 0; i < STALE_WINDOW(); i++) {
      await recordTurn(op, [{ ...browserOk(), content: `page-${i}`, toolCallId: `page-tc-${i}` }]);
    }
    const r = await midTurnStaleMiddleware.beforeTurn!(ctxFor(op, { evidenceHistory: [3, 5, 7] }));
    expect(r.kind).toBe("continue");
  });

  it("worker flat evidence autonomously pivots instead of aborting", async () => {
    _resetMiddlewareStates();
    const op = opId();
    const worker = ctxFor(op, {
      op: { id: op, lane: "build" },
      evidenceHistory: [4, 4, 4],
      toolNames: new Set<string>(),
    });
    const first = await midTurnStaleMiddleware.beforeTurn!(worker);
    expect(first.kind).toBe("nudge");
    expect((first as { reason: string }).reason).toBe("strategy-pivot");
    const second = await midTurnStaleMiddleware.beforeTurn!(worker);
    expect(second.kind).toBe("nudge");
    expect(second.kind).not.toBe("abort");
  });
});

// STALE_WINDOW is a module-internal const; mirror it here so the test reads the
// same threshold without exporting an internal.
function STALE_WINDOW(): number { return 3; }
