import { describe, it, expect } from "vitest";
import type { CanonicalLoopContext } from "./types.js";
import { codebaseAdviceMiddleware } from "./codebase-advice.js";
import { _resetMiddlewareStates } from "./state.js";

let opCounter = 0;

function ctx(over: Partial<CanonicalLoopContext> = {}): CanonicalLoopContext {
  return {
    op: { id: `op-codebase-advice-${opCounter++}`, type: "chat_turn", lane: "interactive" },
    turnIdx: 1,
    userMessage: "Where do we still struggle as a harness, and what should we do next?",
    assistantContent: "The move is to add a verifier middleware and wire it into the canonical loop.",
    toolCalls: [],
    toolsCalledThisOp: new Set<string>(),
    ...over,
  } as unknown as CanonicalLoopContext;
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
