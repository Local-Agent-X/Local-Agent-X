/**
 * Behavior tests for the post-commit middleware: a successful git commit in
 * bash output arms a wrap-up nudge that fires on the NEXT turn.
 *
 * DOUBLY load-bearing: instruction-audit.ts reuses the same checkPostCommit
 * matcher to decide the commit-when-done obligation, so a contract test here
 * drives one tool-result view through BOTH middlewares and asserts they agree.
 * The when-gate (worker lanes only) is covered in worker-op-gate.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { postCommitMiddleware } from "./post-commit.js";
import { _resetMiddlewareStates } from "./state.js";
import { instructionAuditMiddleware } from "./instruction-audit.js";
import { setOpLedger } from "../instruction-ledger/index.js";
import { _resetOpLedgers } from "../instruction-ledger/ledger.js";
import type { CanonicalLoopContext, CanonicalToolResultView } from "./types.js";

let _op = 0;
const opId = () => `op-pcm-test-${++_op}`;

const COMMIT_OUTPUT = "[main abc1234] fix: close the escape\n 2 files changed, 10 insertions(+)";
const NO_COMMIT_OUTPUT = "On branch main\nnothing to commit, working tree clean";

function result(toolName: string, content: string): CanonicalToolResultView {
  return { toolName, toolCallId: "c1", content, status: "ok" };
}

function ctxFor(op: string, toolResults: CanonicalToolResultView[]): CanonicalLoopContext {
  return {
    op: { id: op, lane: "agent" },
    toolCalls: [],
    toolResults,
    assistantContent: "Shipped.",
    toolsCalledThisOp: new Set<string>(),
    attemptedToolsThisOp: new Set<string>(),
  } as unknown as CanonicalLoopContext;
}

const turn = (op: string, ...results: CanonicalToolResultView[]) =>
  postCommitMiddleware.afterToolExecution!(ctxFor(op, results));

beforeEach(() => _resetMiddlewareStates());
afterEach(() => _resetOpLedgers());

describe("post-commit middleware", () => {
  it("arms on a bash git-commit success and nudges on the NEXT turn, once", async () => {
    const op = opId();
    // The commit turn itself passes — the agent gets to see its commit land.
    expect((await turn(op, result("bash", COMMIT_OUTPUT))).kind).toBe("continue");
    // The following turn gets the wrap-up nudge.
    const r = await turn(op, result("bash", "$ ls\nsrc  package.json"));
    expect(r).toMatchObject({ kind: "nudge", reason: "post-commit" });
    if (r.kind === "nudge") expect(r.message).toMatch(/git commit just landed/i);
    // Flag is cleared — no repeat nudge without a fresh commit.
    expect((await turn(op, result("bash", "$ ls\nsrc"))).kind).toBe("continue");
  });

  it("recognizes the 'shell' tool name too", async () => {
    const op = opId();
    await turn(op, result("shell", COMMIT_OUTPUT));
    expect((await turn(op, result("shell", "done"))).kind).toBe("nudge");
  });

  it("ignores commit-shaped text from non-shell tools", async () => {
    const op = opId();
    await turn(op, result("read", COMMIT_OUTPUT));
    expect((await turn(op, result("bash", "$ ls\nsrc"))).kind).toBe("continue");
  });

  it("does not arm on bash output without a commit signature", async () => {
    const op = opId();
    await turn(op, result("bash", NO_COMMIT_OUTPUT));
    expect((await turn(op, result("bash", "$ ls\nsrc"))).kind).toBe("continue");
  });

  it("a fresh commit re-arms the nudge after a previous one fired", async () => {
    const op = opId();
    await turn(op, result("bash", COMMIT_OUTPUT));
    expect((await turn(op, result("bash", "ok"))).kind).toBe("nudge");
    await turn(op, result("bash", COMMIT_OUTPUT));
    expect((await turn(op, result("bash", "ok"))).kind).toBe("nudge");
  });
});

describe("post-commit ↔ instruction-audit commit-when-done contract", () => {
  // instruction-audit.ts:76-80 reuses checkPostCommit as its commit detector.
  // These lock the coupling: the SAME tool output must move both verdicts.
  // If the commit matcher shifts, both sides of each case shift together.

  const commitLedger = () => ({
    prohibitions: [],
    obligations: [{ kind: "commit-when-done" as const }],
    phrases: ["commit when you're done"],
  });

  function auditCtx(op: string, toolResults: CanonicalToolResultView[]): CanonicalLoopContext {
    return ctxFor(op, toolResults);
  }

  it("output that arms post-commit ALSO satisfies instruction-audit's obligation", async () => {
    const op = opId();
    setOpLedger(op, commitLedger());
    const results = [result("bash", COMMIT_OUTPUT)];
    // post-commit sees a commit (nudges next turn)...
    await turn(op, ...results);
    expect((await turn(op, result("bash", "ok"))).kind).toBe("nudge");
    // ...and the same output marks the obligation met at wrap-up.
    await instructionAuditMiddleware.afterToolExecution!(auditCtx(op, results));
    const verdict = await instructionAuditMiddleware.afterModelCall!(auditCtx(op, []));
    expect(verdict.kind).toBe("continue");
  });

  it("output that does NOT arm post-commit leaves the obligation unmet", async () => {
    const op = opId();
    setOpLedger(op, commitLedger());
    const results = [result("bash", NO_COMMIT_OUTPUT)];
    // post-commit stays quiet...
    await turn(op, ...results);
    expect((await turn(op, result("bash", "ok"))).kind).toBe("continue");
    // ...and instruction-audit flags the unmet commit-when-done at wrap-up.
    await instructionAuditMiddleware.afterToolExecution!(auditCtx(op, results));
    const verdict = await instructionAuditMiddleware.afterModelCall!(auditCtx(op, []));
    expect(verdict.kind).toBe("nudge");
    if (verdict.kind === "nudge") expect(verdict.message).toMatch(/COMMIT when done/i);
  });
});
