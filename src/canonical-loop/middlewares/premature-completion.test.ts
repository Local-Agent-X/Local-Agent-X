import { describe, it, expect, afterEach } from "vitest";
import { prematureCompletionMiddleware } from "./premature-completion.js";
import type { CanonicalLoopContext } from "./types.js";
import { setOpLedger } from "../instruction-ledger/index.js";
import { _resetOpLedgers } from "../instruction-ledger/ledger.js";
import type { CapabilityClass } from "../../tool-registry.js";

let _op = 0;
function opId(): string { return `op-pc-test-${++_op}`; }

function ctxFor(op: string, over: Partial<CanonicalLoopContext> = {}): CanonicalLoopContext {
  return {
    op: { id: op, lane: "agent" },
    userMessage: "refactor the parser and save the result",
    assistantContent: "All done — here's a summary of what I'd change.",
    toolCalls: [],
    committingToolsThisOp: new Set<string>(),
    ...over,
  } as unknown as CanonicalLoopContext;
}

function forbid(op: string, ...prohibitions: CapabilityClass[]): void {
  setOpLedger(op, { prohibitions, obligations: [], phrases: ["don't change anything"] });
}

const run = (c: CanonicalLoopContext) => prematureCompletionMiddleware.afterModelCall!(c);

afterEach(() => _resetOpLedgers());

describe("premature-completion guard", () => {
  it("nudges a worker op that ends tool-lessly with nothing committed", async () => {
    const r = await run(ctxFor(opId()));
    expect(r).toMatchObject({ kind: "nudge", reason: "premature-completion" });
  });

  it("only applies to worker lanes", () => {
    expect(prematureCompletionMiddleware.when!(ctxFor(opId()))).toBe(true);
    expect(
      prematureCompletionMiddleware.when!(ctxFor(opId(), { op: { id: "i", lane: "interactive" } as never })),
    ).toBe(false);
  });

  it("continues when the turn called tools, committed, or said nothing", async () => {
    expect((await run(ctxFor(opId(), { toolCalls: [{} as never] }))).kind).toBe("continue");
    expect((await run(ctxFor(opId(), { committingToolsThisOp: new Set(["write"]) }))).kind).toBe("continue");
    expect((await run(ctxFor(opId(), { assistantContent: "  " }))).kind).toBe("continue");
  });

  it("fires at most once per op", async () => {
    const op = opId();
    expect((await run(ctxFor(op))).kind).toBe("nudge");
    expect((await run(ctxFor(op))).kind).toBe("continue");
  });
});

describe("premature-completion — instruction-ledger gating", () => {
  it("is suppressed when the user forbade workspace writes (read-only op)", async () => {
    const op = opId();
    forbid(op, "workspace-write");
    expect((await run(ctxFor(op))).kind).toBe("continue");
  });

  it("still nudges when the ledger forbids only an unrelated capability", async () => {
    const op = opId();
    forbid(op, "egress");
    expect((await run(ctxFor(op))).kind).toBe("nudge");
  });
});
