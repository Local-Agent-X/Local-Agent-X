/**
 * Behavior tests for the action-claim middleware: regex claim gate
 * (agent-guards/action-claim.ts) + LLM second opinion (claim-verify.ts,
 * mocked at the module seam — same idiom as attribution-claim.test.ts).
 * The when-gate (worker lanes only) is covered in worker-op-gate.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { actionClaimMiddleware } from "./action-claim.js";
import { _resetMiddlewareStates } from "./state.js";
import { verifyClaimHallucinationWithLLM } from "../../classifiers/claim-verify.js";
import type { CanonicalLoopContext } from "./types.js";

vi.mock("../../classifiers/claim-verify.js", () => ({
  verifyClaimHallucinationWithLLM: vi.fn(async () => true),
}));
const mockVerify = vi.mocked(verifyClaimHallucinationWithLLM);

let _op = 0;
const opId = () => `op-ac-test-${++_op}`;

function ctxFor(op: string, over: Partial<CanonicalLoopContext> = {}): CanonicalLoopContext {
  return {
    op: { id: op, lane: "agent" },
    assistantContent: "I removed the stale cron job and cleared the queue.",
    toolCalls: [],
    toolsCalledThisOp: new Set<string>(),
    ...over,
  } as unknown as CanonicalLoopContext;
}

const run = (c: CanonicalLoopContext) => actionClaimMiddleware.afterModelCall!(c);

beforeEach(() => {
  _resetMiddlewareStates();
  mockVerify.mockReset().mockResolvedValue(true);
});

describe("action-claim middleware", () => {
  it("nudges an unexecuted action claim when the verifier confirms it", async () => {
    const r = await run(ctxFor(opId()));
    expect(r).toMatchObject({ kind: "nudge", reason: "action-claim" });
    if (r.kind === "nudge") {
      expect(r.message).toContain("no matching tool was called");
    }
  });

  it("passes the reply and the op's actually-called tools to the verifier", async () => {
    await run(ctxFor(opId(), { toolsCalledThisOp: new Set(["read", "grep"]) }));
    expect(mockVerify).toHaveBeenCalledWith(
      "I removed the stale cron job and cleared the queue.",
      ["read", "grep"],
    );
  });

  it("stays quiet when the claimed verb's tool WAS called this op — verifier never consulted", async () => {
    const r = await run(ctxFor(opId(), { toolsCalledThisOp: new Set(["bash"]) }));
    expect(r.kind).toBe("continue");
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("stays quiet on plain prose with no action claim", async () => {
    const r = await run(ctxFor(opId(), {
      assistantContent: "Here's my analysis of the parser — the tokenizer is the weak spot.",
    }));
    expect(r.kind).toBe("continue");
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("checks interleaved turns too: tool calls made, but a DIFFERENT unexecuted action claimed", async () => {
    // Live failure shape: model calls read, then narrates "npm run check passed"
    // without any bash/process_start ever running.
    const r = await run(ctxFor(opId(), {
      assistantContent: "npm run check passed, so the fix is verified.",
      toolCalls: [{ toolCallId: "r1", tool: "read", args: {} }] as never,
      toolsCalledThisOp: new Set(["read"]),
    }));
    expect(r).toMatchObject({ kind: "nudge", reason: "action-claim" });
  });

  it("verifier veto (false) suppresses the nudge WITHOUT burning the once-per-op fuse", async () => {
    const op = opId();
    mockVerify.mockResolvedValue(false);
    expect((await run(ctxFor(op))).kind).toBe("continue");
    // A later, genuinely-hallucinated claim in the same op must still fire.
    mockVerify.mockResolvedValue(true);
    expect((await run(ctxFor(op))).kind).toBe("nudge");
  });

  it("verifier unavailable (null) falls back to the regex verdict and nudges", async () => {
    mockVerify.mockResolvedValue(null);
    expect((await run(ctxFor(opId()))).kind).toBe("nudge");
  });

  it("fires at most once per op", async () => {
    const op = opId();
    expect((await run(ctxFor(op))).kind).toBe("nudge");
    expect((await run(ctxFor(op))).kind).toBe("continue");
    expect(mockVerify).toHaveBeenCalledTimes(1);
  });
});
