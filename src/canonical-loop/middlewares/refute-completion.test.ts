import { describe, it, expect, vi, beforeEach } from "vitest";

// Control the refutation panel so the middleware's gating + messaging can be
// tested without a provider. The panel itself is covered elsewhere.
// vi.hoisted: refute-completion.ts imports refuteClaim STATICALLY, so the hoisted
// vi.mock factory runs at import time — the mock fn must exist by then.
const { refuteClaimMock } = vi.hoisted(() => ({ refuteClaimMock: vi.fn() }));
vi.mock("../../classifiers/refute-claim.js", () => ({ refuteClaim: refuteClaimMock }));

import { refuteCompletionMiddleware } from "./refute-completion.js";
import type { CanonicalLoopContext } from "./types.js";

let _op = 0;
function opId(): string { return `op-refute-test-${++_op}`; }

function ctxFor(
  op: string,
  opts: {
    lane?: string;
    task?: string;
    claim?: string;
    toolCalls?: number;
    committing?: string[];
    used?: string[];
  },
): CanonicalLoopContext {
  return {
    op: { id: op, lane: opts.lane ?? "agent" },
    userMessage: opts.task ?? "Implement feature X and add a test.",
    assistantContent: opts.claim ?? "All done — feature X is implemented.",
    toolCalls: new Array(opts.toolCalls ?? 0).fill({ name: "x" }),
    committingToolsThisOp: new Set(opts.committing ?? ["write", "bash"]),
    toolsCalledThisOp: new Set(opts.used ?? ["read", "write", "bash"]),
  } as unknown as CanonicalLoopContext;
}

const run = (op: string, opts: Parameters<typeof ctxFor>[1]) =>
  refuteCompletionMiddleware.afterModelCall!(ctxFor(op, opts));

describe("refuteCompletionMiddleware", () => {
  beforeEach(() => {
    refuteClaimMock.mockReset();
    refuteClaimMock.mockResolvedValue({ refuted: false, verdict: {}, summary: "0/3", reasons: [] });
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
    expect(await run(opId(), { committing: [] })).toEqual({ kind: "continue" });
    expect(refuteClaimMock).not.toHaveBeenCalled();
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
