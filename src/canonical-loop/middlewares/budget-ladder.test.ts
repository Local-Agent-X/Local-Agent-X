import { describe, it, expect, beforeEach } from "vitest";
import { budgetLadderMiddleware } from "./budget-ladder.js";
import { makeCanonicalLoopContext } from "./ctx.test-helper.js";
import { getMiddlewareState, clearMiddlewareStateForOp } from "./state.js";
import { createLoopState, type LoopState } from "../../agent-guards/index.js";

const MAX = 160;

function ctxAt(turnIdx: number, opId: string) {
  return makeCanonicalLoopContext({
    turnIdx,
    op: {
      id: opId,
      contextPack: {
        task: { description: "", successCriteria: [], constraints: [], notWhatToRedo: [] },
        context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" },
        capabilities: {},
        budget: { maxIterations: MAX, maxTokens: 0, maxWallTimeMs: 0, maxSelfEditCalls: 0 },
        routing: { lane: "agent" },
        secrets: { allowed: [] },
      },
    },
  });
}

/** Give the op's shared loop-detection state N distinct observed results. */
function setEvidence(opId: string, n: number): void {
  const loop = getMiddlewareState<LoopState>(opId, "loop-detection", createLoopState);
  loop.seenResultSigs.clear();
  for (let i = 0; i < n; i++) loop.seenResultSigs.add(`sig-${i}`);
}

let opId = "";
let seq = 0;
beforeEach(() => {
  opId = `op-ladder-${seq++}`;
  clearMiddlewareStateForOp(opId);
});

describe("budget-ladder — rungs", () => {
  it("stays silent before the first rung", async () => {
    setEvidence(opId, 5);
    const r = await budgetLadderMiddleware.beforeTurn!(ctxAt(39, opId));
    expect(r.kind).toBe("continue");
  });

  it("fires a self-assessment at 25% of the budget", async () => {
    setEvidence(opId, 5);
    const r = await budgetLadderMiddleware.beforeTurn!(ctxAt(40, opId));
    expect(r.kind).toBe("nudge");
    expect((r as { message: string }).message).toContain("25%");
  });

  it("fires each rung at most once", async () => {
    setEvidence(opId, 5);
    expect((await budgetLadderMiddleware.beforeTurn!(ctxAt(40, opId))).kind).toBe("nudge");
    expect((await budgetLadderMiddleware.beforeTurn!(ctxAt(41, opId))).kind).toBe("continue");
    expect((await budgetLadderMiddleware.beforeTurn!(ctxAt(50, opId))).kind).toBe("continue");
  });

  it("skips the ladder entirely on a small budget", async () => {
    const ctx = makeCanonicalLoopContext({
      turnIdx: 30,
      op: {
        id: opId,
        contextPack: {
          task: { description: "", successCriteria: [], constraints: [], notWhatToRedo: [] },
          context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" },
          capabilities: {},
          budget: { maxIterations: 12, maxTokens: 0, maxWallTimeMs: 0, maxSelfEditCalls: 0 },
          routing: { lane: "agent" },
          secrets: { allowed: [] },
        },
      },
    });
    expect((await budgetLadderMiddleware.beforeTurn!(ctx)).kind).toBe("continue");
  });
});

describe("budget-ladder — dry-rung stop", () => {
  it("tells the agent to stop and ask after two rungs with no new evidence", async () => {
    setEvidence(opId, 40);
    // 25% — first rung, no prior count to compare against.
    const first = await budgetLadderMiddleware.beforeTurn!(ctxAt(40, opId));
    expect((first as { message: string }).message).toContain("25%");
    // 50% — evidence unchanged: one dry rung, still a normal assessment.
    const second = await budgetLadderMiddleware.beforeTurn!(ctxAt(80, opId));
    expect((second as { message: string }).message).toContain("50%");
    // 75% — a second consecutive dry rung: stop and ask.
    const third = await budgetLadderMiddleware.beforeTurn!(ctxAt(120, opId));
    expect(third.kind).toBe("nudge");
    expect((third as { reason?: string }).reason).toBe("budget-ladder-dry");
    expect((third as { message: string }).message).toContain("no new information");
  });

  it("does not fire the dry stop while the op keeps learning", async () => {
    setEvidence(opId, 10);
    await budgetLadderMiddleware.beforeTurn!(ctxAt(40, opId));
    setEvidence(opId, 25); // learned something between rungs
    await budgetLadderMiddleware.beforeTurn!(ctxAt(80, opId));
    setEvidence(opId, 60); // and again
    const third = await budgetLadderMiddleware.beforeTurn!(ctxAt(120, opId));
    expect((third as { reason?: string }).reason).toBe("budget-ladder");
    expect((third as { message: string }).message).toContain("75%");
  });

  it("cannot fire the dry stop on the first rung alone", async () => {
    setEvidence(opId, 0); // no evidence at all yet
    const first = await budgetLadderMiddleware.beforeTurn!(ctxAt(40, opId));
    expect((first as { reason?: string }).reason).toBe("budget-ladder");
  });
});
