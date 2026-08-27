import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

vi.mock("../store.js", () => ({ readOpTurns: vi.fn(() => []) }));

import { prematureCompletionMiddleware } from "./premature-completion.js";
import type { CanonicalLoopContext } from "./types.js";
import { readOpTurns } from "../store.js";
import { setOpLedger } from "../instruction-ledger/index.js";
import { _resetOpLedgers } from "../instruction-ledger/ledger.js";
import type { CapabilityClass } from "../../tool-registry.js";
import { makeCanonicalLoopContext, type CanonicalLoopContextOverrides } from "./ctx.test-helper.js";

const mockOpTurns = vi.mocked(readOpTurns);

let _op = 0;
function opId(): string { return `op-pc-test-${++_op}`; }

/**
 * The gate reads host-precomputed ctx sets, never op_turns (host.ts already
 * walked those rows; host.test.ts pins the projection). `committing` is the
 * RAW name-only tally (what mid-turn-stale's abort brake reads), `substantive`
 * the completion-gate one — passing them
 * separately is what lets a test state which question it is exercising.
 */
function ctxFor(
  op: string,
  over: CanonicalLoopContextOverrides = {},
  substantive: string[] = [],
): CanonicalLoopContext {
  return makeCanonicalLoopContext({
    op: { id: op, lane: "agent" },
    userMessage: "refactor the parser and save the result",
    assistantContent: "All done — here's a summary of what I'd change.",
    toolCalls: [],
    committingToolsThisOp: new Set<string>(),
    substantiveCommittingToolsThisOp: new Set<string>(substantive),
    ...over,
  });
}

function forbid(op: string, ...prohibitions: CapabilityClass[]): void {
  setOpLedger(op, { prohibitions, obligations: [], phrases: ["don't change anything"] });
}

const run = (c: CanonicalLoopContext) => prematureCompletionMiddleware.afterModelCall!(c);

beforeEach(() => {
  vi.clearAllMocks();
  mockOpTurns.mockReturnValue([]);
});
afterEach(() => _resetOpLedgers());

describe("premature-completion guard", () => {
  it("nudges a worker op that ends tool-lessly with nothing committed", async () => {
    const r = await run(ctxFor(opId()));
    expect(r).toMatchObject({ kind: "nudge", reason: "premature-completion" });
  });

  it("only applies to worker lanes", () => {
    expect(prematureCompletionMiddleware.when!(ctxFor(opId()))).toBe(true);
    expect(
      prematureCompletionMiddleware.when!(ctxFor(opId(), { op: { id: "i", lane: "interactive" } })),
    ).toBe(false);
  });

  it("continues when the turn called tools, committed, or said nothing", async () => {
    expect((await run(ctxFor(opId(), { toolCalls: [{} as never] }))).kind).toBe("continue");
    expect((await run(ctxFor(opId(), { committingToolsThisOp: new Set(["write"]) }, ["write"]))).kind).toBe("continue");
    expect((await run(ctxFor(opId(), { assistantContent: "  " }))).kind).toBe("continue");
  });

  // The gate asks "did the worker act on the USER'S task?" — not "did it write
  // its own to-do list?". task_create is risk:workspace-write, so the raw
  // committingToolsThisOp tally counts it and let a planning-only op escape.
  it("still nudges when the op's only committing calls were its own task ledger", async () => {
    const r = await run(ctxFor(opId(), { committingToolsThisOp: new Set(["task_create", "task_update"]) }, []));
    expect(r).toMatchObject({ kind: "nudge", reason: "premature-completion" });
  });

  it("stays quiet when the op committed real work alongside its plan", async () => {
    const r = await run(ctxFor(opId(), { committingToolsThisOp: new Set(["task_create", "write"]) }, ["write"]));
    expect(r.kind).toBe("continue");
  });

  // The 24% blind spot: browser is the most-called tool in the whole history
  // and the name-only layer answers false for it, so a worker that spent the op
  // filing a form and then summarized it read as having taken NO action.
  it("stays quiet for an op whose only work was an arg-aware tool", async () => {
    for (const tool of ["pdf", "browser", "http_request"]) {
      expect((await run(ctxFor(opId(), {}, [tool]))).kind).toBe("continue");
    }
  });

  it("still nudges the read-only sibling of those same tools", async () => {
    // A `pdf read` / navigating browser leaves the substantive set empty.
    expect((await run(ctxFor(opId(), { toolsCalledThisOp: new Set(["pdf", "browser"]) }, []))).kind)
      .toBe("nudge");
  });

  it("never re-reads op_turns — host already walked them", async () => {
    await run(ctxFor(opId()));
    await run(ctxFor(opId(), {}, ["write"]));
    expect(mockOpTurns).not.toHaveBeenCalled();
  });

  it("fires at most once per op", async () => {
    const op = opId();
    expect((await run(ctxFor(op))).kind).toBe("nudge");
    expect((await run(ctxFor(op))).kind).toBe("continue");
  });
});

describe("premature-completion — instruction-ledger gating", () => {
  it("is suppressed when the user forbade workspace writes (read-only op)", async () => {
    const op = opId();
    forbid(op, "workspace-write");
    expect((await run(ctxFor(op))).kind).toBe("continue");
  });

  it("still nudges when the ledger forbids only an unrelated capability", async () => {
    const op = opId();
    forbid(op, "egress");
    expect((await run(ctxFor(op))).kind).toBe("nudge");
  });
});
