import { describe, it, expect, beforeEach } from "vitest";
import type { CanonicalLoopContext } from "./types.js";
import {
  createInstructionLedgerMiddleware,
  instructionLedgerMiddleware,
} from "./instruction-ledger.js";
import { extractConstraints } from "../instruction-ledger/extract.js";
import { getOpLedger, opHasConstraints } from "../instruction-ledger/index.js";
// Test-only reset helper — deliberately not on the index.ts public surface.
import { _resetOpLedgers } from "../instruction-ledger/ledger.js";
import type { InstructionLedger } from "../instruction-ledger/index.js";
import { _resetMiddlewareStates } from "./state.js";

let opCounter = 0;

function ctx(over: Partial<CanonicalLoopContext> = {}): CanonicalLoopContext {
  return {
    op: { id: `op-instruction-ledger-${opCounter++}`, type: "agent_spawn", lane: "background" },
    turnIdx: 0,
    userMessage: "Fix the bug in the scheduler.",
    assistantContent: "",
    toolCalls: [],
    toolsCalledThisOp: new Set<string>(),
    ...over,
  } as unknown as CanonicalLoopContext;
}

// Real extractor with the LLM confirm stubbed to null — exercises the genuine
// phrase-gate + strong-tier path deterministically, zero network.
const offlineExtract = (msg: string) => extractConstraints(msg, async () => null);

beforeEach(() => {
  _resetMiddlewareStates();
  _resetOpLedgers();
});

describe("instructionLedgerMiddleware", () => {
  it("turn 0: records a workspace-write prohibition for 'don't edit'", async () => {
    const mw = createInstructionLedgerMiddleware(offlineExtract);
    const c = ctx({ userMessage: "Find the root cause but don't edit any code." });
    const r = await mw.beforeTurn!(c);
    expect(r.kind).toBe("continue");
    expect(getOpLedger(c.op.id)?.prohibitions).toContain("workspace-write");
  });

  it("app_build op: SKIPS extraction (synthetic per-build context is not a user constraint)", async () => {
    let called = false;
    const spyExtract = (msg: string) => { called = true; return offlineExtract(msg); };
    const mw = createInstructionLedgerMiddleware(spyExtract);
    // This message WOULD yield a workspace-write ban on a normal op — but on an
    // app_build op it's the harness-authored per-build context, so it's ignored.
    const c = ctx({
      op: { id: "op-appbuild-x", type: "app_build", lane: "build" } as never,
      userMessage: "You are building a web app. You must NOT edit core LAX; leave the locked files alone; do not edit the baseline.",
    });
    const r = await mw.beforeTurn!(c);
    expect(r.kind).toBe("continue");
    expect(called).toBe(false); // extractor never ran
    expect(getOpLedger(c.op.id)).toEqual({ prohibitions: [], obligations: [], phrases: [] });
  });

  it("turn 0: records the EMPTY ledger for an unconstrained message", async () => {
    const mw = createInstructionLedgerMiddleware(offlineExtract);
    const c = ctx(); // "Fix the bug…" — no constraint cues
    const r = await mw.beforeTurn!(c);
    expect(r.kind).toBe("continue");
    expect(getOpLedger(c.op.id)).toEqual({ prohibitions: [], obligations: [], phrases: [] });
    expect(opHasConstraints(c.op.id)).toBe(false);
  });

  it("turn 1+: no-op — no extraction, no ledger write", async () => {
    let calls = 0;
    const mw = createInstructionLedgerMiddleware(async () => {
      calls++;
      return { prohibitions: [], obligations: [], phrases: [] };
    });
    const c = ctx({ turnIdx: 1 });
    const r = await mw.beforeTurn!(c);
    expect(r.kind).toBe("continue");
    expect(calls).toBe(0);
    expect(getOpLedger(c.op.id)).toBeUndefined();
  });

  it("fires once per op — a re-driven turn 0 does not re-extract", async () => {
    let calls = 0;
    const mw = createInstructionLedgerMiddleware(async (): Promise<InstructionLedger> => {
      calls++;
      return { prohibitions: ["workspace-write"], obligations: [], phrases: ["don't edit"] };
    });
    const c = ctx({ userMessage: "don't edit anything" });
    await mw.beforeTurn!(c);
    await mw.beforeTurn!(c);
    expect(calls).toBe(1);
    expect(getOpLedger(c.op.id)?.prohibitions).toEqual(["workspace-write"]);
  });

  it("fail-open: an extractor throw records the empty ledger, never blocks", async () => {
    const mw = createInstructionLedgerMiddleware(async () => {
      throw new Error("extractor exploded");
    });
    const c = ctx({ userMessage: "don't edit anything" });
    const r = await mw.beforeTurn!(c);
    expect(r.kind).toBe("continue");
    expect(getOpLedger(c.op.id)).toEqual({ prohibitions: [], obligations: [], phrases: [] });
    expect(opHasConstraints(c.op.id)).toBe(false);
  });

  it("default instance: unconstrained message takes the no-cue path (no LLM) and stays permissive", async () => {
    // phraseGate finds no cues → extractConstraints returns empty without any
    // confirm call, so the default (un-injected) middleware is network-free here.
    const c = ctx({ userMessage: "Refactor the parser and add tests." });
    const r = await instructionLedgerMiddleware.beforeTurn!(c);
    expect(r.kind).toBe("continue");
    expect(opHasConstraints(c.op.id)).toBe(false);
  });
});
