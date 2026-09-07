import { describe, it, expect, beforeEach } from "vitest";
import { budgetLadderMiddleware } from "./budget-ladder.js";
import { makeCanonicalLoopContext } from "./ctx.test-helper.js";
import { getMiddlewareState, clearMiddlewareStateForOp } from "./state.js";
import { createLoopState, noteToolResults, type LoopState } from "../../agent-guards/index.js";
import { RESULT_SIG_MEMORY } from "../../agent-guards/loop-progress.js";

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

function loopOf(opId: string): LoopState {
  return getMiddlewareState<LoopState>(opId, "loop-detection", createLoopState);
}

/** Feed the op `n` DISTINCT tool results through the real noteToolResults, so
 *  the evidence the ladder reads moves the way production moves it. Mirrors
 *  checkpoint-stop.test.ts — the two predicates must read the same signal. */
let resultSeq = 0;
const lastLearned = new Map<string, string>();
function learn(opId: string, n: number): void {
  const state = loopOf(opId);
  for (let i = 0; i < n; i++) {
    const call = [{ name: "search", arguments: `{"q":"${resultSeq}"}` }];
    const content = `finding-${opId}-${resultSeq++}`;
    lastLearned.set(opId, content);
    noteToolResults(call, state, [{ content, status: "ok" }]);
  }
}

/** Feed the op a result it has ALREADY seen (its most recent one) — learns
 *  nothing. A fresh literal would itself be novel the first time. */
function repeat(opId: string, n: number): void {
  const state = loopOf(opId);
  const content = lastLearned.get(opId);
  if (content === undefined) throw new Error(`repeat() before learn() for ${opId}`);
  for (let i = 0; i < n; i++) {
    noteToolResults([{ name: "search", arguments: "{}" }], state, [{ content, status: "ok" }]);
  }
}

/** Bring the op's evidence to exactly `n` distinct results (only ever upward —
 *  novelty is monotonic in production too). */
function setEvidence(opId: string, n: number): void {
  const have = loopOf(opId).progressTotal;
  if (n < have) throw new Error(`setEvidence(${n}) below current ${have}`);
  learn(opId, n - have);
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

  it("keeps a productive op alive past 256 distinct results, where the Set size would have called it dry", async () => {
    const loop = loopOf(opId);
    const reasonAt = async (turn: number) =>
      (await budgetLadderMiddleware.beforeTurn!(ctxAt(turn, opId)) as { reason?: string }).reason;

    // 25% rung: already past the cap — the Set is saturated from here on.
    learn(opId, 270);
    expect(loop.seenResultSigs.size).toBe(RESULT_SIG_MEMORY);
    expect(await reasonAt(40)).toBe("budget-ladder");

    // 50% rung: 40 more distinct results. The Set's size has not moved; the
    // counter has. Reading .size here would count this as the first dry rung.
    learn(opId, 40);
    expect(loop.seenResultSigs.size).toBe(RESULT_SIG_MEMORY);
    expect(loop.progressTotal).toBe(310);
    expect(await reasonAt(80)).toBe("budget-ladder");

    // 75% rung: still learning every turn. Under .size this would be the
    // second consecutive dry rung and the op would be told to stop.
    learn(opId, 40);
    expect(loop.seenResultSigs.size).toBe(RESULT_SIG_MEMORY);
    expect(loop.progressTotal).toBe(350);
    expect(await reasonAt(120)).toBe("budget-ladder");
  });

  // Same regression as checkpoint-stop.test.ts "write-only work is progress":
  // the ladder reads the same counter, so write-only scaffolding must never
  // read as two dry rungs here either.
  it("does not call an op dry when every turn between rungs wrote a NEW file", async () => {
    const loop = loopOf(opId);
    const reasonAt = async (turn: number) =>
      (await budgetLadderMiddleware.beforeTurn!(ctxAt(turn, opId)) as { reason?: string }).reason;
    let n = 0;
    const scaffold = (files: number) => {
      for (let i = 0; i < files; i++) {
        noteToolResults(
          [{ name: "write", arguments: JSON.stringify({ path: `/w/f-${n++}.ts`, content: `v${n}` }) }],
          loop,
          [{ content: "ok", status: "ok" }],
        );
      }
    };
    scaffold(4);
    expect(await reasonAt(40)).toBe("budget-ladder");
    scaffold(4);
    expect(await reasonAt(80)).toBe("budget-ladder");
    scaffold(4);
    expect(await reasonAt(120)).toBe("budget-ladder"); // not "budget-ladder-dry"
    expect(loop.seenResultSigs.size).toBe(0); // the SET still excludes the write's "ok"
    expect(loop.progressTotal).toBe(12);
  });

  it("still stops honestly past 256 distinct results once the op actually goes dry", async () => {
    const reasonAt = async (turn: number) =>
      (await budgetLadderMiddleware.beforeTurn!(ctxAt(turn, opId)) as { reason?: string }).reason;

    learn(opId, 300);
    expect(await reasonAt(40)).toBe("budget-ladder");
    repeat(opId, 20); // nothing new between the rungs
    expect(await reasonAt(80)).toBe("budget-ladder"); // one dry rung
    repeat(opId, 20);
    expect(await reasonAt(120)).toBe("budget-ladder-dry"); // two: stop and ask
  });
});
