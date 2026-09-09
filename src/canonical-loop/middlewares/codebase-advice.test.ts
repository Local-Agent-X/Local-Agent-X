import { describe, it, expect } from "vitest";
import type { CanonicalLoopContext } from "./types.js";
import { codebaseAdviceMiddleware } from "./codebase-advice.js";
import { _resetMiddlewareStates } from "./state.js";
import { makeCanonicalLoopContext } from "./ctx.test-helper.js";

let opCounter = 0;

function ctx(over: Partial<CanonicalLoopContext> = {}): CanonicalLoopContext {
  return makeCanonicalLoopContext({
    op: { id: `op-codebase-advice-${opCounter++}`, type: "chat_turn", lane: "interactive" },
    turnIdx: 1,
    currentUserMessage: "Where do we still struggle as a harness, and what should we do next?",
    assistantContent: "The move is to add a verifier middleware and wire it into the canonical loop.",
    toolCalls: [],
    toolsCalledThisOp: new Set<string>(),
    ...over,
  });
}

const fire = (c: CanonicalLoopContext) => codebaseAdviceMiddleware.afterModelCall!(c);

describe("codebaseAdviceMiddleware", () => {
  it("nudges implementation advice given without current code inspection", async () => {
    _resetMiddlewareStates();
    const r = await fire(ctx());
    expect(r.kind).toBe("nudge");
    if (r.kind === "nudge") {
      expect(r.reason).toBe("codebase-advice-grounding");
      expect(r.message).toContain("fresh code evidence");
    }
  });

  it("continues when the model is still calling tools", async () => {
    _resetMiddlewareStates();
    const r = await fire(ctx({ toolCalls: [{ toolCallId: "r1", tool: "read", args: {} }] }));
    expect(r.kind).toBe("continue");
  });

  it("continues once code was inspected this op", async () => {
    _resetMiddlewareStates();
    const r = await fire(ctx({ toolsCalledThisOp: new Set(["read"]) }));
    expect(r.kind).toBe("continue");
  });

  it("continues when the assistant says it needs to inspect first", async () => {
    _resetMiddlewareStates();
    const r = await fire(ctx({
      assistantContent: "I need to read the codebase before recommending the next harness change.",
    }));
    expect(r.kind).toBe("continue");
  });

  it("fires at most once per op", async () => {
    _resetMiddlewareStates();
    const c = ctx();
    expect((await fire(c)).kind).toBe("nudge");
    expect((await fire(c)).kind).toBe("continue");
  });
});

// ctx.userMessage is the session's FIRST user row, not the message that opened
// this op. The "is this a codebase-advice request?" classifier must read the
// current request — in both directions.
describe("codebase-advice — classifies the CURRENT request, not the session's opening line", () => {
  it("stays quiet when only the stale opening line asked for codebase advice", async () => {
    _resetMiddlewareStates();
    const r = await fire(ctx({
      userMessage: "Where do we still struggle as a harness, and what should we do next?",
      currentUserMessage: "What's the capital of France?",
    }));
    expect(r.kind).toBe("continue");
  });

  it("nudges when the current request asks for codebase advice, whatever the opening line was", async () => {
    _resetMiddlewareStates();
    const r = await fire(ctx({
      userMessage: "What's the capital of France?",
      currentUserMessage: "Where do we still struggle as a harness, and what should we do next?",
    }));
    expect(r.kind).toBe("nudge");
  });
});

// Same misfire class as broad-sweep-nudge: the harness composes task text that
// reads exactly like a user asking for repo direction (a dream brief's "what
// should we do next", an eval prompt's harness question). Provenance is the
// only thing that separates those from a human's ask.
describe("codebase-advice — harness-authored task text is not a user request", () => {
  const ADVICE_ASK = "Where do we still struggle as a harness, and what should we do next?";
  const UNGROUNDED = "The move is to add a verifier middleware and wire it into the canonical loop.";

  const build = (op: Record<string, unknown>) =>
    makeCanonicalLoopContext({
      op: { id: `op-codebase-advice-${opCounter++}`, ...op },
      turnIdx: 1,
      currentUserMessage: ADVICE_ASK,
      assistantContent: UNGROUNDED,
      toolCalls: [],
      toolsCalledThisOp: new Set<string>(),
    });

  it("nudges this exact text on a user-authored op — the baseline the gate must not break", async () => {
    _resetMiddlewareStates();
    const r = await fire(build({ type: "chat_turn", lane: "interactive" }));
    expect(r.kind).toBe("nudge");
  });

  it("stays quiet on a provenance-stamped harness op (the memory_consolidation cluster)", async () => {
    _resetMiddlewareStates();
    const r = await fire(
      build({ type: "memory_consolidation", lane: "background", taskProvenance: "harness" }),
    );
    expect(r).toEqual({ kind: "continue" });
  });

  // op.type is MODEL-supplied and unvalidated (ops/tools/shared.ts:172); gating
  // on it would let a model switch this guard off by labelling its op. Only the
  // harness-written provenance stamp gates.
  it("STILL nudges an unstamped op that merely CLAIMS type app_build — op.type is not a muzzle", async () => {
    _resetMiddlewareStates();
    const r = await fire(build({ type: "app_build" }));
    expect(r.kind).toBe("nudge");
  });
});
