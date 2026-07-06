import { describe, expect, it, vi } from "vitest";
import type { CanonicalLoopContext } from "./types.js";
import { createOperationalClaimMiddleware, operationalClaimMiddleware } from "./operational-claim.js";

// The default instance's confirm routes through classifyYesNo. Unit tests must
// never reach a live provider: mocked to null = "classifier unavailable", which
// fails open to the deterministic regex verdict — exactly today's behavior, so
// the pre-existing tests below pin the same contract they always did.
vi.mock("../../classifiers/classify-with-llm.js", () => ({
  classifyYesNo: vi.fn(async () => null),
}));

let counter = 0;
function ctx(over: Partial<CanonicalLoopContext> = {}): CanonicalLoopContext {
  return {
    op: { id: `operational-${counter++}`, type: "chat_turn", lane: "interactive" },
    turnIdx: 0,
    toolCalls: [],
    assistantContent: "The kernel applied a permanent block because an old event raised the threat level.",
    toolsCalledThisOp: new Set(),
    attemptedToolsThisOp: new Set(),
    ...over,
  } as CanonicalLoopContext;
}

describe("operational-claim middleware", () => {
  it("nudges and marks the false answer retractable", async () => {
    const result = await operationalClaimMiddleware.afterModelCall!(ctx());
    expect(result).toMatchObject({
      kind: "nudge",
      reason: "unsupported-operational-claim",
    });
  });

  it("continues after fresh inspection evidence", async () => {
    const result = await operationalClaimMiddleware.afterModelCall!(ctx({
      toolsCalledThisOp: new Set(["read_my_logs"]),
    }));
    expect(result).toEqual({ kind: "continue" });
  });

  it("lets an in-flight diagnostic tool execute before judging the final answer", async () => {
    const result = await operationalClaimMiddleware.afterModelCall!(ctx({
      toolCalls: [{ toolCallId: "call-1", tool: "read_my_logs", args: {} }],
    }));
    expect(result).toEqual({ kind: "continue" });
  });

  it("fires at most once per op", async () => {
    const c = ctx();
    expect((await operationalClaimMiddleware.afterModelCall!(c)).kind).toBe("nudge");
    expect(await operationalClaimMiddleware.afterModelCall!(c)).toEqual({ kind: "continue" });
  });
});

describe("LLM confirm gates the retract consequence (regex is the prefilter)", () => {
  it("suppresses the fire entirely when the confirm rejects it as a false positive", async () => {
    const mw = createOperationalClaimMiddleware(async () => false);
    expect(await mw.afterModelCall!(ctx())).toEqual({ kind: "continue" });
  });

  it("negation-blindness fix: 'the firewall did NOT block the request' is suppressed on confirmed-false", async () => {
    // The regex prefilter cannot see negation — this sentence trips it. Before
    // the confirm gate, that fired a retract-grade nudge on a non-claim.
    const mw = createOperationalClaimMiddleware(async () => false);
    const result = await mw.afterModelCall!(ctx({
      assistantContent: "The firewall did NOT block the request.",
    }));
    expect(result).toEqual({ kind: "continue" });
  });

  it("fires as today when the confirm agrees", async () => {
    const mw = createOperationalClaimMiddleware(async () => true);
    expect(await mw.afterModelCall!(ctx())).toMatchObject({
      kind: "nudge",
      reason: "unsupported-operational-claim",
    });
  });

  it("fails open: null confirm (timeout/disabled) fires exactly as today", async () => {
    const mw = createOperationalClaimMiddleware(async () => null);
    expect(await mw.afterModelCall!(ctx())).toMatchObject({
      kind: "nudge",
      reason: "unsupported-operational-claim",
    });
  });

  it("fails open: a confirm that throws fires exactly as today", async () => {
    const mw = createOperationalClaimMiddleware(async () => { throw new Error("provider down"); });
    expect((await mw.afterModelCall!(ctx())).kind).toBe("nudge");
  });

  it("hands the confirm the exact flagged sentence plus the full reply", async () => {
    const seen: Array<[string, string]> = [];
    const mw = createOperationalClaimMiddleware(async (sentence, full) => {
      seen.push([sentence, full]);
      return false;
    });
    const reply = "Let me check the details. The firewall blocked the request. More context follows.";
    await mw.afterModelCall!(ctx({ assistantContent: reply }));
    expect(seen).toEqual([["The firewall blocked the request.", reply]]);
  });

  it("never calls the confirm when the regex prefilter does not fire", async () => {
    const confirm = vi.fn(async () => false);
    const mw = createOperationalClaimMiddleware(confirm);
    const result = await mw.afterModelCall!(ctx({
      assistantContent: "The function returns early because the array is empty.",
    }));
    expect(result).toEqual({ kind: "continue" });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("a suppressed fire does not consume the once-per-op budget", async () => {
    let verdict: boolean | null = false;
    const mw = createOperationalClaimMiddleware(async () => verdict);
    const c = ctx();
    expect(await mw.afterModelCall!(c)).toEqual({ kind: "continue" });
    verdict = true; // a later, genuine claim in the same op must still fire
    expect((await mw.afterModelCall!(c)).kind).toBe("nudge");
  });
});
