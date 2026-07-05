import { describe, it, expect, afterEach } from "vitest";
import { toolSearchNudgeMiddleware, looksLikeCapabilityDenial } from "./tool-search-nudge.js";
import type { CanonicalLoopContext } from "./types.js";
import { setOpLedger } from "../instruction-ledger/index.js";
import { _resetOpLedgers } from "../instruction-ledger/ledger.js";
import type { CapabilityClass } from "../../tool-registry.js";

let _op = 0;
function opId(): string { return `op-tsn-test-${++_op}`; }

function ctxFor(
  op: string,
  opts: { content: string; toolCalls?: number; searchedThisOp?: boolean },
): CanonicalLoopContext {
  return {
    op: { id: op },
    assistantContent: opts.content,
    toolCalls: new Array(opts.toolCalls ?? 0).fill({ name: "x" }),
    toolsCalledThisOp: new Set(opts.searchedThisOp ? ["tool_search"] : []),
  } as unknown as CanonicalLoopContext;
}

const run = (op: string, opts: Parameters<typeof ctxFor>[1]) =>
  toolSearchNudgeMiddleware.afterModelCall!(ctxFor(op, opts));

describe("looksLikeCapabilityDenial", () => {
  it("fires on capability denials", () => {
    for (const t of [
      "I do not have a computer control tool or mouse movement capability.",
      "Sorry, I can't move the mouse.",
      "I don't have the ability to control your computer.",
      "There's no tool for that.",
      "That's beyond my capabilities.",
      "I'm not able to click on things for you.",
      "No tool for mouse control.",
      "Can't click that — no mouse control.",
    ]) {
      expect(looksLikeCapabilityDenial(t), t).toBe(true);
    }
  });

  it("does NOT fire on ethical refusals", () => {
    for (const t of [
      "I won't help with that request.",
      "I'm not comfortable assisting with that.",
      "I can't help with that request — it could cause harm.",
    ]) {
      expect(looksLikeCapabilityDenial(t), t).toBe(false);
    }
  });

  it("does NOT fire on normal answers", () => {
    for (const t of [
      "The capital of France is Paris.",
      "Here's the summary you asked for: the build passed and tests are green.",
      "Done — I moved the file and updated the imports.",
      "No, Paris is the capital of France.",
      "",
    ]) {
      expect(looksLikeCapabilityDenial(t), t).toBe(false);
    }
  });
});

describe("tool-search-nudge middleware", () => {
  it("nudges on a capability denial with zero tool calls", async () => {
    const r = await run(opId(), { content: "I don't have a tool to move the mouse." });
    expect(r.kind).toBe("nudge");
    expect((r as { reason: string }).reason).toBe("tool-search-recovery");
    expect((r as { message: string }).message).toContain("tool_search");
  });

  it("does NOT nudge when the turn made tool calls", async () => {
    const r = await run(opId(), { content: "I can't move the mouse.", toolCalls: 1 });
    expect(r.kind).toBe("continue");
  });

  it("does NOT nudge when tool_search already ran this op", async () => {
    const r = await run(opId(), { content: "I can't move the mouse.", searchedThisOp: true });
    expect(r.kind).toBe("continue");
  });

  it("does NOT nudge on a normal tool-less answer", async () => {
    const r = await run(opId(), { content: "The capital of France is Paris." });
    expect(r.kind).toBe("continue");
  });

  it("does NOT nudge on an ethical refusal", async () => {
    const r = await run(opId(), { content: "I won't help with that request." });
    expect(r.kind).toBe("continue");
  });

  it("fires at most once per op", async () => {
    const op = opId();
    expect((await run(op, { content: "I can't do that — no tool for it." })).kind).toBe("nudge");
    expect((await run(op, { content: "Still can't, I have no such tool." })).kind).toBe("continue");
  });
});

describe("instruction-ledger gating (targeted suppression)", () => {
  afterEach(() => _resetOpLedgers());

  function forbid(op: string, ...prohibitions: CapabilityClass[]): void {
    setOpLedger(op, { prohibitions, obligations: [], phrases: ["no browsing"] });
  }

  it("suppresses the nudge when the denial is about a capability the user forbade", async () => {
    const op = opId();
    forbid(op, "egress");
    const r = await run(op, { content: "I can't browse the web to fetch that page." });
    expect(r.kind).toBe("continue");
  });

  it("still nudges when the denial is about a DIFFERENT capability than the forbidden one", async () => {
    const op = opId();
    forbid(op, "egress");
    const r = await run(op, { content: "Sorry, I can't move the mouse." });
    expect(r.kind).toBe("nudge");
  });

  it("still nudges with no ledger at all (fail-open)", async () => {
    const r = await run(opId(), { content: "I can't browse the web to fetch that page." });
    expect(r.kind).toBe("nudge");
  });
});
