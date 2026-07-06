/**
 * Behavior tests for the hallucination-check middleware. The approval and
 * worker paths are regex-final BY DESIGN — provable from the tool ledger
 * (hallucination-check.ts:50), so these lock that the LLM verifier is never
 * consulted there. Only the creation path (turn 0) has the LLM seam.
 * The when-gate (worker lanes only) is covered in worker-op-gate.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { hallucinationCheckMiddleware } from "./hallucination-check.js";
import { verifyClaimHallucinationWithLLM } from "../../classifiers/claim-verify.js";
import type { CanonicalLoopContext } from "./types.js";

vi.mock("../../classifiers/claim-verify.js", () => ({
  verifyClaimHallucinationWithLLM: vi.fn(async () => true),
}));
const mockVerify = vi.mocked(verifyClaimHallucinationWithLLM);

let _op = 0;
const opId = () => `op-hc-test-${++_op}`;

function ctxFor(over: Partial<CanonicalLoopContext> = {}): CanonicalLoopContext {
  return {
    op: { id: opId(), lane: "agent" },
    turnIdx: 1,
    assistantContent: "",
    toolCalls: [],
    toolsCalledThisOp: new Set<string>(),
    ...over,
  } as unknown as CanonicalLoopContext;
}

const run = (c: CanonicalLoopContext) => hallucinationCheckMiddleware.afterModelCall!(c);

beforeEach(() => mockVerify.mockReset().mockResolvedValue(true));

describe("hallucination-check — approval path (regex-final)", () => {
  it("nudges a permission-request hallucination without consulting the LLM", async () => {
    const r = await run(ctxFor({
      assistantContent: "This change requires approval — please approve before I proceed.",
    }));
    expect(r).toMatchObject({ kind: "nudge", reason: "approval-hallucination" });
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("fires on mixed turns too (tool calls made, approval still hallucinated)", async () => {
    const r = await run(ctxFor({
      assistantContent: "I've read the file; the edit needs your approval to proceed.",
      toolCalls: [{ toolCallId: "r1", tool: "read", args: {} }] as never,
    }));
    expect(r).toMatchObject({ kind: "nudge", reason: "approval-hallucination" });
  });

  it("does not fire on benign approval nouns ('this was approved')", async () => {
    const r = await run(ctxFor({ assistantContent: "The PR was approved yesterday, merging now." }));
    expect(r.kind).toBe("continue");
  });
});

describe("hallucination-check — worker path (regex-final, every turn)", () => {
  const WORKER_CLAIM = "A background worker is on it for PR. Dominican and Brazil added to the same run.";

  it("nudges a background-worker narration with no successful spawn in the ledger", async () => {
    const r = await run(ctxFor({
      assistantContent: WORKER_CLAIM,
      toolsCalledThisOp: new Set(["read", "grep"]),
    }));
    expect(r).toMatchObject({ kind: "nudge", reason: "worker-hallucination" });
    // Provably false from the tool ledger — no LLM second opinion by design.
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("fires on later turns too, not just turn 0", async () => {
    const r = await run(ctxFor({ assistantContent: WORKER_CLAIM, turnIdx: 4 }));
    expect(r).toMatchObject({ kind: "nudge", reason: "worker-hallucination" });
  });

  it("stays quiet when a spawn-class tool actually succeeded this op", async () => {
    const r = await run(ctxFor({
      assistantContent: WORKER_CLAIM,
      toolsCalledThisOp: new Set(["agent_spawn"]),
    }));
    expect(r.kind).toBe("continue");
  });
});

describe("hallucination-check — creation path (turn 0, LLM seam)", () => {
  const CREATION_CLAIM = "I added the nightly summary mission to your schedule.";

  it("nudges a turn-0 creation claim when the verifier confirms it", async () => {
    const r = await run(ctxFor({ assistantContent: CREATION_CLAIM, turnIdx: 0 }));
    expect(r).toMatchObject({ kind: "nudge", reason: "creation-hallucination" });
    expect(mockVerify).toHaveBeenCalledWith(CREATION_CLAIM, []);
  });

  it("verifier veto (false) suppresses the creation nudge", async () => {
    mockVerify.mockResolvedValue(false);
    const r = await run(ctxFor({ assistantContent: CREATION_CLAIM, turnIdx: 0 }));
    expect(r.kind).toBe("continue");
  });

  it("verifier unavailable (null) falls back to the regex verdict and nudges", async () => {
    mockVerify.mockResolvedValue(null);
    const r = await run(ctxFor({ assistantContent: CREATION_CLAIM, turnIdx: 0 }));
    expect(r).toMatchObject({ kind: "nudge", reason: "creation-hallucination" });
  });

  it("does not run the creation check after turn 0", async () => {
    const r = await run(ctxFor({ assistantContent: CREATION_CLAIM, turnIdx: 1 }));
    expect(r.kind).toBe("continue");
    expect(mockVerify).not.toHaveBeenCalled();
  });
});

describe("hallucination-check — empty turns", () => {
  it("continues when the turn produced no assistant text", async () => {
    expect((await run(ctxFor({ assistantContent: "" }))).kind).toBe("continue");
  });
});
