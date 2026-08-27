import { describe, it, expect, vi, beforeEach } from "vitest";

// Control the refutation panel so the middleware's gating + messaging can be
// tested without a provider. The panel itself is covered elsewhere.
// vi.hoisted: refute-completion.ts imports refuteClaim STATICALLY, so the hoisted
// vi.mock factory runs at import time — the mock fn must exist by then.
const { refuteClaimMock } = vi.hoisted(() => ({ refuteClaimMock: vi.fn() }));
vi.mock("../../classifiers/refute-claim.js", () => ({ refuteClaim: refuteClaimMock }));
vi.mock("../store.js", () => ({ readOpTurns: vi.fn(() => []) }));

import { refuteCompletionMiddleware } from "./refute-completion.js";
import type { CanonicalLoopContext } from "./types.js";
import { readOpTurns } from "../store.js";
import { makeCanonicalLoopContext } from "./ctx.test-helper.js";

const mockOpTurns = vi.mocked(readOpTurns);

let _op = 0;
function opId(): string { return `op-refute-test-${++_op}`; }

/**
 * The gate reads host-precomputed ctx sets, never op_turns (host.test.ts pins
 * that projection). `committing` is the RAW name-only tally and
 * `substantive` the completion-gate one — they are deliberately settable
 * apart so a test can prove the gate reads the right one.
 */
function ctxFor(
  op: string,
  opts: {
    lane?: string;
    task?: string;
    claim?: string;
    toolCalls?: number;
    committing?: string[];
    substantive?: string[];
    used?: string[];
  },
): CanonicalLoopContext {
  return makeCanonicalLoopContext({
    op: { id: op, lane: opts.lane ?? "agent" },
    userMessage: opts.task ?? "Implement feature X and add a test.",
    assistantContent: opts.claim ?? "All done — feature X is implemented.",
    toolCalls: new Array(opts.toolCalls ?? 0).fill({ name: "x" }),
    committingToolsThisOp: new Set(opts.committing ?? ["write", "bash"]),
    substantiveCommittingToolsThisOp: new Set(opts.substantive ?? ["write", "bash"]),
    toolsCalledThisOp: new Set(opts.used ?? ["read", "write", "bash"]),
  });
}

const run = (op: string, opts: Parameters<typeof ctxFor>[1]) =>
  refuteCompletionMiddleware.afterModelCall!(ctxFor(op, opts));

describe("refuteCompletionMiddleware", () => {
  beforeEach(() => {
    refuteClaimMock.mockReset();
    refuteClaimMock.mockResolvedValue({ refuted: false, verdict: {}, summary: "0/3", reasons: [] });
    mockOpTurns.mockReset();
    mockOpTurns.mockReturnValue([]);
  });

  it("is worker-only (when excludes interactive lanes)", () => {
    expect(refuteCompletionMiddleware.when!(ctxFor(opId(), { lane: "interactive" }))).toBe(false);
    expect(refuteCompletionMiddleware.when!(ctxFor(opId(), { lane: "agent" }))).toBe(true);
  });

  it("stays quiet (and never fires the panel) while still calling tools", async () => {
    expect(await run(opId(), { toolCalls: 2 })).toEqual({ kind: "continue" });
    expect(refuteClaimMock).not.toHaveBeenCalled();
  });

  it("stays quiet when NO work was committed (premature-completion's case, not ours)", async () => {
    expect(await run(opId(), { committing: [], substantive: [] })).toEqual({ kind: "continue" });
    expect(refuteClaimMock).not.toHaveBeenCalled();
  });

  // The gate asks "is there enough real work to be worth paying a skeptic
  // pass?". task_create is risk:workspace-write, so the raw committingToolsThisOp
  // tally bought an LLM panel for a planning-only op with nothing to refute.
  it("does not buy a panel for a planning-only op (task ledger is not work)", async () => {
    expect(await run(opId(), { committing: ["task_create", "task_update"], substantive: [] }))
      .toEqual({ kind: "continue" });
    expect(refuteClaimMock).not.toHaveBeenCalled();
  });

  it("still fires the panel when real work was committed alongside the plan", async () => {
    await run(opId(), { committing: ["task_create", "write"], substantive: ["write"] });
    expect(refuteClaimMock).toHaveBeenCalledTimes(1);
  });

  // browser/pdf/http_request work was invisible to the name-only tally, so an
  // op that spent itself in the browser bought no skeptic pass at all.
  it("buys a panel for an op whose only work was an arg-aware tool", async () => {
    await run(opId(), { committing: [], substantive: ["browser"] });
    expect(refuteClaimMock).toHaveBeenCalledTimes(1);
  });

  // Item 6: the panel must be told what the gate just counted, not the raw
  // tally it deliberately refused to count.
  it("reports the SUBSTANTIVE actions to the panel, not the raw tally", async () => {
    await run(opId(), { committing: ["task_create", "task_update", "pdf"], substantive: ["pdf"] });
    const context = refuteClaimMock.mock.calls[0][0].context as string;
    expect(context).toContain("Committing actions it actually took this op: pdf.");
    expect(context).not.toContain("task_create");
    expect(context).not.toContain("task_update");
  });

  it("never re-reads op_turns — host already walked them", async () => {
    await run(opId(), {});
    expect(mockOpTurns).not.toHaveBeenCalled();
  });

  it("stays quiet on an empty final message", async () => {
    expect(await run(opId(), { claim: "   " })).toEqual({ kind: "continue" });
    expect(refuteClaimMock).not.toHaveBeenCalled();
  });

  it("fails OPEN when the panel does not refute", async () => {
    refuteClaimMock.mockResolvedValue({ refuted: false, verdict: {}, summary: "1/3", reasons: ["weak"] });
    expect(await run(opId(), {})).toEqual({ kind: "continue" });
  });

  it("fails OPEN when the panel throws", async () => {
    refuteClaimMock.mockRejectedValue(new Error("provider down"));
    expect(await run(opId(), {})).toEqual({ kind: "continue" });
  });

  it("nudges with the skeptics' reasons on a majority refutation", async () => {
    refuteClaimMock.mockResolvedValue({
      refuted: true,
      verdict: {},
      summary: "2/3 skeptics refuted the claim",
      reasons: ["no test was added", "feature X still throws on empty input"],
    });
    const r = await run(opId(), {});
    expect(r).toMatchObject({ kind: "nudge", reason: "refute-completion" });
    expect((r as { message: string }).message).toContain("2/3 skeptics refuted the claim");
    expect((r as { message: string }).message).toContain("no test was added");
  });

  it("fires at most once per op", async () => {
    refuteClaimMock.mockResolvedValue({ refuted: true, verdict: {}, summary: "3/3", reasons: ["x"] });
    const op = opId();
    expect(await run(op, {})).toMatchObject({ kind: "nudge" });
    expect(await run(op, {})).toEqual({ kind: "continue" });
    expect(refuteClaimMock).toHaveBeenCalledTimes(1);
  });
});
