// The guard fire counter's contract — the ledger in guard-fire.ts, asserted.
//
// The harness steers the model with ~30 behavioral guards and, before
// `middleware_fired`, counted none of them: canonical-events.jsonl carried 16
// event types across 2,478 persisted ops and not one was a guard firing, so a
// fire count could only be recovered by string-matching nudge PROSE in
// op_messages — a record that rewording a nudge silently destroys. Guards get
// RETIRED on this evidence (2026-07-10), so an uncounted path reads as a dead
// guard and the counter has to cover every way a guard's verdict lands: nudge,
// abort (both phases), suspend (both phases), a silent arg rewrite, and a gate
// that authors a turn's closing words.
//
// `outcome` is the discriminator that makes those distinguishable at a
// distance. Every body assertion below states it, because a fire filed under
// the wrong shape is a real miscount hiding inside a green test — and the
// unresolved-tool-intent pair proves the point: same name, same reason, same
// turnIdx, two different things the guard did.
//
// Every assertion reads the REAL persisted event log (readCanonicalEvents),
// never a spy on `emit`.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Partial mock — the render-verify gate's probe is the cheapest way to make a
// real completion gate fire on demand; everything else in the module (and the
// whole store path under it) stays real.
vi.mock("./render-verify.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./render-verify.js")>();
  return {
    ...actual,
    runRenderVerifyGate: vi.fn(async () => ({ nudge: "", retryCount: 0, shouldRetry: false, capReached: false })),
  };
});

vi.mock("./spec-audit.js", () => ({
  runSpecAuditGate: vi.fn(async () => ({ nudge: "Spec drift.", shouldRetry: true })),
}));
vi.mock("./design-verify.js", () => ({
  runDesignVerifyGate: vi.fn(() => ({ nudge: "Design score too low.", shouldRetry: true, capReached: false })),
}));
// Partial — registry.ts imports openStepsMiddleware from here; only the gate's
// entry condition is steered.
vi.mock("../middlewares/open-steps.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../middlewares/open-steps.js")>()),
  earnedDoneNudge: vi.fn(() => "Finish the open steps or justify stopping."),
  // The epilogue's `endedPartial` switch — the one thing that decides whether
  // build-verify's green line is ever shown, and so whether its fire is earned.
  openStepsTerminationWarning: vi.fn((): string | null => null),
}));
// Partial — spec-audit's entry condition is the only export these tests steer.
vi.mock("../middlewares/verify-gate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../middlewares/verify-gate.js")>()),
  opEditedSourcePaths: vi.fn(() => ["src/x.ts"]),
}));
// framework-serve's only real side effect. Mocked because a genuine
// {handled:true, ok:true} needs a framework app on disk AND a live dev-server
// registry; which VERDICT earns a fire is what these tests own. The gate still
// runs its real op-type / appUrl / appName parsing around it.
vi.mock("../adapters/app-build-finalize.js", () => ({
  finalizeFrameworkBuild: vi.fn(async () => ({ handled: false })),
}));

import { appendNudgeAsUserMessage, middlewareAbortResult, recoverCommittedStrategyPivot } from "./nudges.js";
import { recoverAdapterThrow } from "./adapter-throw-recovery.js";
import { applyCommittedDirective } from "./apply-directive.js";
import { idleSuspension, suspendedTurn } from "./suspension.js";
import { COMPLETION_GATES, unresolvedToolIntentGate, type CompletionGate, type CompletionGateOutput } from "./decide-outcome-gates.js";
import { bankEarnedFires, type GuardFire } from "./guard-fire.js";
import { runRenderVerifyGate } from "./render-verify.js";
import { officeThemeGuardMiddleware } from "../middlewares/office-theme-guard.js";
import { makeCanonicalLoopContext } from "../middlewares/ctx.test-helper.js";
import { emitErrorOnce } from "../event-emitter.js";
import { insertOpTurn, readCanonicalEvents } from "../store.js";
import { applyTerminalEpilogue } from "./terminal-epilogue.js";
import { openStepsTerminationWarning } from "../middlewares/open-steps.js";
import { finalizeFrameworkBuild } from "../adapters/app-build-finalize.js";
import { _resetInjectQueues, pushInject } from "../../agent-loop/inject-queue.js";
import { trackOpForSession } from "../../ops/session-bridge.js";
import type { CanonicalEvent, GuardOutcome, MiddlewareFiredBody, OpTurnRow } from "../types.js";
import type { CommitTurnMessage } from "../checkpoint.js";
import type { FiredMiddlewareResult } from "../middlewares/host.js";
import type { MiddlewareDirective } from "./types.js";
import type { Op } from "../../ops/types.js";
import type { ToolCall } from "../contract-types.js";

// Unique opId per test — HOME is a throwaway (test/setup/test-env.ts), so the
// real op dirs land under it and never touch the developer's ~/.lax.
let opSeq = 0;
let opId = "";
beforeEach(() => { opId = `op_mw_fired_${opSeq++}`; });

const op = (): Op => ({ id: opId, type: "chat_turn", task: "t" }) as unknown as Op;

/** What actually reached canonical-events.jsonl for this op. */
function firesOnDisk(id: string): CanonicalEvent[] {
  return readCanonicalEvents(id).filter(e => e.type === "middleware_fired");
}

function typesOnDisk(id: string): string[] {
  return readCanonicalEvents(id).map(e => e.type);
}

const EFFECTS = { appendNudgeAsUserMessage, recoverCommittedStrategyPivot, emitErrorOnce };

/** Exhaustive census of the closed outcome vocabulary — the same device
 *  `event-vocabulary.test.ts` uses on the event union. Widening `GuardOutcome`
 *  fails tsc HERE until the new shape is deliberately admitted, so a fifth
 *  shape cannot ship unasserted. */
const OUTCOME_CENSUS: Record<GuardOutcome, true> = {
  nudge: true,
  abort: true,
  suspend: true,
  rewrite: true,
  "honest-terminal": true,
  reopen: true,
  repair: true,
  "gave-up": true,
};
const OUTCOMES = Object.keys(OUTCOME_CENSUS);

describe("middleware_fired — a nudging middleware is counted", () => {
  it("persists one event carrying the firing middleware's name, reason and turn", () => {
    expect(appendNudgeAsUserMessage(opId, 3, "Stop and re-read the task.", {
      name: "loop-detection",
      reason: "loop-detection",
      outcome: "nudge",
    })).toBe(true);

    const fires = firesOnDisk(opId);
    expect(fires).toHaveLength(1);
    // The typed literal pins the shape at COMPILE time against
    // MiddlewareFiredBody — a RENAMED or wrong-typed field stops tsc. It does
    // NOT catch an extra field (MiddlewareFiredBody extends
    // Record<string, unknown>, so `{…, bogus: 1}` compiles clean); the
    // Object.keys assertion in the next test is what closes that half.
    const expected: MiddlewareFiredBody = { name: "loop-detection", reason: "loop-detection", outcome: "nudge", turnIdx: 3 };
    expect(fires[0]!.body).toEqual(expected);
    // The nudge itself still lands — the counter is additive, not a swap.
    expect(typesOnDisk(opId)).toEqual(["message_appended", "middleware_fired"]);
  });

  it("body contract: exactly {name, outcome, reason, turnIdx}", () => {
    appendNudgeAsUserMessage(opId, 0, "n", { name: "thrash-guard", reason: "thrash-guard", outcome: "nudge" });
    const body = firesOnDisk(opId)[0]!.body as MiddlewareFiredBody;
    // Exact key set — the only assertion that catches an ADDED field. Keep it
    // exact: a subset check would let a fifth field ship uncounted, which is
    // the whole failure this event exists to end.
    expect(Object.keys(body).sort()).toEqual(["name", "outcome", "reason", "turnIdx"]);
    expect(typeof body.name).toBe("string");
    expect(typeof body.reason).toBe("string");
    expect(typeof body.turnIdx).toBe("number");
    expect(OUTCOMES).toContain(body.outcome);
  });

  it("a middleware whose reason differs from its name keeps BOTH", () => {
    // post-turn-detector fires as `post-turn:<kind>`; collapsing reason into
    // name would erase which detector rule actually tripped.
    appendNudgeAsUserMessage(opId, 1, "n", { name: "post-turn-detector", reason: "post-turn:tool-repeat", outcome: "nudge" });
    expect(firesOnDisk(opId)[0]!.body).toEqual({
      name: "post-turn-detector",
      reason: "post-turn:tool-repeat",
      outcome: "nudge",
      turnIdx: 1,
    });
  });

  it("a nudge SUPPRESSED by stableMessageId is not a fire", () => {
    const stable = `strategy-pivot-${opId}-0`;
    expect(appendNudgeAsUserMessage(opId, 1, "pivot", { name: "strategy-pivot", reason: "strategy-pivot", outcome: "nudge" }, undefined, stable)).toBe(true);
    // Same id again — restart recovery replaying the same committed pivot.
    expect(appendNudgeAsUserMessage(opId, 1, "pivot", { name: "strategy-pivot", reason: "strategy-pivot", outcome: "nudge" }, undefined, stable)).toBe(false);
    expect(firesOnDisk(opId)).toHaveLength(1);
    expect(typesOnDisk(opId)).toEqual(["message_appended", "middleware_fired"]);
  });
});

// D6 — the pivot mechanism is shared by loop-detection, mid-turn-stale and
// strategy-pivot. A hard-coded name would file all three under one and leave
// the other two reading 0.
describe("middleware_fired — a recovered pivot keeps the ORIGINATING guard's name", () => {
  function commitPivotTurn(firedBy: string | undefined): void {
    const row: OpTurnRow = {
      opId,
      turnIdx: 0,
      providerState: { adapterName: "test", adapterVersion: "1", providerPayload: {} },
      toolCallSummary: [],
      terminalReason: null,
      redirectConsumed: false,
      createdAt: new Date().toISOString(),
      nextTurnPivot: {
        message: "Try a different approach.",
        ...(firedBy === undefined ? {} : { firedBy }),
        metadata: { strategyPivot: { pattern: "p", strategyId: "context-refresh", epoch: 1 } },
      },
    };
    expect(insertOpTurn(row)).toBe(true);
  }

  it("files the fire under the middleware that authored the pivot, not the mechanism", () => {
    commitPivotTurn("loop-detection");
    expect(recoverCommittedStrategyPivot(opId, 0)).toBe(true);
    expect(firesOnDisk(opId)[0]!.body).toEqual({
      name: "loop-detection",
      reason: "strategy-pivot",
      // The recovered pivot builds its own GuardFire literal rather than going
      // through directiveFire/firedResultFire — it is one of the two producers
      // a helper-only change would leave shapeless.
      outcome: "nudge",
      turnIdx: 1,
    });
  });

  it("a row committed before firedBy existed records `unknown`, not a guess", () => {
    commitPivotTurn(undefined);
    expect(recoverCommittedStrategyPivot(opId, 0)).toBe(true);
    expect((firesOnDisk(opId)[0]!.body as MiddlewareFiredBody).name).toBe("unknown");
  });
});

describe("middleware_fired — an aborting middleware is counted in BOTH phases", () => {
  const beforeTurnAbort: FiredMiddlewareResult = {
    kind: "abort",
    reason: "repeat-failure",
    firedBy: "repeat-failure",
    message: "Same failure three times.",
  };
  const stickyAbort: MiddlewareDirective = {
    kind: "abort",
    reason: "loop-detection",
    firedBy: "loop-detection",
    message: "Looping on the same edit.",
  };

  it("beforeTurn: emits alongside the abort error, naming the guard that stopped the turn", () => {
    const result = middlewareAbortResult(op(), 7, beforeTurnAbort);
    expect(result.terminalReason).toBe("error");

    const fires = firesOnDisk(opId);
    expect(fires).toHaveLength(1);
    const expected: MiddlewareFiredBody = { name: "repeat-failure", reason: "repeat-failure", outcome: "abort", turnIdx: 7 };
    expect(fires[0]!.body).toEqual(expected);
    // The pre-existing error bubble is untouched — the count is added, not swapped.
    expect(typesOnDisk(opId)).toEqual(["error", "middleware_fired"]);
  });

  // D1 — middlewareAbortResult has ONE caller (the beforeTurn phase). Every
  // abort from afterModelCall / afterToolExecution — loop-detection,
  // repeat-output, repeat-failure, thrash-guard, the strategy-pivot ceiling —
  // reaches the op through the sticky directive instead, which used to emit
  // only `error`. Those are the ABORT tiers of two-tier guards: counting only
  // the nudge tier and dropping the tier that ends the op is exactly the
  // reading a retirement review would get wrong.
  it("afterModelCall / afterToolExecution: the sticky directive counts too", () => {
    applyCommittedDirective(op(), 4, stickyAbort, EFFECTS);
    const expected: MiddlewareFiredBody = { name: "loop-detection", reason: "loop-detection", outcome: "abort", turnIdx: 4 };
    expect(firesOnDisk(opId)[0]!.body).toEqual(expected);
    expect(typesOnDisk(opId)).toEqual(["error", "middleware_fired"]);
  });

  // D7 — the fire must dedup WITH its sibling error, not beside it.
  // chat-runner/event-pump.ts holds an adapter's `aborted` for exactly one
  // event; any non-cause event flushes it. An unconditional fire next to a
  // deduped emitErrorOnce would flush that hold and show the user "aborted"
  // AND the cause instead of the cause alone.
  it("a repeat of the SAME abort emits nothing at all the second time", () => {
    applyCommittedDirective(op(), 4, stickyAbort, EFFECTS);
    const afterFirst = readCanonicalEvents(opId).length;
    applyCommittedDirective(op(), 5, stickyAbort, EFFECTS);
    expect(readCanonicalEvents(opId)).toHaveLength(afterFirst);
    expect(firesOnDisk(opId)).toHaveLength(1);
  });
});

// D2 — `suspend` is the autonomous lane's pause: repeat-failure and
// thrash-guard suspend instead of aborting on worker lanes, and the
// idle-watchdog suspends a stalled one. Nothing else recorded that a guard did
// it — worker.ts's transitionOp(paused) records the STATE, not the cause.
describe("middleware_fired — a suspending middleware is counted in every phase", () => {
  it("beforeTurn: suspendedTurn records the guard that paused the op", () => {
    const out = suspendedTurn(opId, 2, {
      kind: "suspend", reason: "thrash-guard", firedBy: "thrash-guard", message: "Thrashing.",
    });
    expect(out?.terminalReason).toBeNull();
    const expected: MiddlewareFiredBody = { name: "thrash-guard", reason: "thrash-guard", outcome: "suspend", turnIdx: 2 };
    expect(firesOnDisk(opId)[0]!.body).toEqual(expected);
  });

  it("beforeTurn: a non-suspend verdict records nothing", () => {
    expect(suspendedTurn(opId, 2, { kind: "continue" })).toBeNull();
    expect(firesOnDisk(opId)).toHaveLength(0);
  });

  it("afterToolExecution: the sticky suspend directive counts", () => {
    applyCommittedDirective(op(), 6, {
      kind: "suspend", reason: "repeat-failure", firedBy: "repeat-failure", message: "Paused.",
    }, EFFECTS);
    expect(firesOnDisk(opId)[0]!.body).toEqual({
      name: "repeat-failure", reason: "repeat-failure", outcome: "suspend", turnIdx: 6,
    });
    // A suspend has no error bubble — the fire is the ONLY record.
    expect(typesOnDisk(opId)).toEqual(["middleware_fired"]);
  });

  it("the idle-watchdog's suspend counts under its own name", () => {
    const directive = idleSuspension("build", { code: "stalled", message: "No activity for 10m." });
    applyCommittedDirective(op(), 3, directive!, EFFECTS);
    expect(firesOnDisk(opId)[0]!.body).toEqual({
      name: "idle-watchdog", reason: "idle-stalled", outcome: "suspend", turnIdx: 3,
    });
  });
});

describe("middleware_fired — a completion gate is counted too", () => {
  const renderVerify = COMPLETION_GATES.find(g => g.name === "render-verify")!;
  const APP_WRITE: ToolCall[] = [
    { toolCallId: "t1", tool: "write", args: { path: "workspace/apps/todo/index.html" } },
  ];

  it("a gate nudge names the GATE, on the turn the nudge targets (turnIdx + 1)", async () => {
    vi.mocked(runRenderVerifyGate).mockResolvedValueOnce({
      nudge: "Your page threw on load.", retryCount: 1, shouldRetry: true, capReached: false,
    });
    const out = await renderVerify.evaluate({
      op: { ...op(), type: "app_build", appUrl: "http://127.0.0.1:7007/apps/todo/index.html" } as Op,
      turnIdx: 4,
      toolCalls: APP_WRITE,
      assistantText: "",
    });
    expect(out.reopen).toBe(true);

    const fires = firesOnDisk(opId);
    expect(fires).toHaveLength(1);
    // Gates carry no separate reason string, so the gate name is both halves.
    const expected: MiddlewareFiredBody = { name: "render-verify", reason: "render-verify", outcome: "nudge", turnIdx: 5 };
    expect(fires[0]!.body).toEqual(expected);
  });

  it("a gate that does NOT nudge emits nothing", async () => {
    vi.mocked(runRenderVerifyGate).mockResolvedValueOnce({
      nudge: "", retryCount: 0, shouldRetry: false, capReached: false,
    });
    await renderVerify.evaluate({
      op: { ...op(), type: "app_build" } as Op,
      turnIdx: 4,
      toolCalls: APP_WRITE,
      assistantText: "",
    });
    expect(firesOnDisk(opId)).toHaveLength(0);
  });

  // D3 — tool-intent-gate.ts: "First fire per op → one retry nudge; every later
  // fire → honestTerminal". Only the first spoke through a nudge, so ten leaked
  // turns used to record 1. Both are counted — but in two DIFFERENT places,
  // because only one of them is safe to mint from inside the gate.
  it("unresolved-tool-intent banks its nudge immediately and DEFERS its terminal", () => {
    const LEAKED =
      "Searching.\n" +
      '<atem:function_calls><atem:invoke name="grep"><atem:parameter name="pattern">x</atem:parameter></atem:invoke></atem:function_calls>';
    const ctx = { op: op(), turnIdx: 0, toolCalls: [], assistantText: LEAKED };

    const first = unresolvedToolIntentGate.evaluate(ctx) as CompletionGateOutput;
    expect(first.reopen).toBe(true);
    const second = unresolvedToolIntentGate.evaluate({ ...ctx, turnIdx: 1 }) as CompletionGateOutput;
    expect(second.honestTerminal).toBeDefined();

    // The NUDGE is banked on the spot: appendNudgeAsUserMessage already wrote
    // the row into op_messages, and a later reopen cannot un-write it.
    expect(firesOnDisk(opId).map(e => e.body)).toEqual([
      { name: "unresolved-tool-intent", reason: "unresolved-tool-intent", outcome: "nudge", turnIdx: 1 },
    ]);
    // The TERMINAL is not, and must not be: this gate is 6th of 9 and a later
    // gate can still reopen the turn, and even a settled terminal is in-memory
    // until commitTurn. The gate NAMES the fire beside the text it belongs to;
    // whoever appends the text earns it.
    expect(second.honestTerminal?.fire).toEqual(
      { name: "unresolved-tool-intent", reason: "unresolved-tool-intent", outcome: "honest-terminal" },
    );
  });
});

// D5 — a guard that acts by REWRITING the model's tool call, not by speaking.
// Its verdict is `continue`, so no nudge and no directive records it; without
// this it reads 0 forever while actively overriding the model.
describe("middleware_fired — a guard that rewrites tool args is counted", () => {
  const deck = (): ToolCall[] => [
    { toolCallId: "t1", tool: "presentation", args: { action: "create", theme: "scandal red" } },
  ];

  it("counts the strip under the guard's own name", () => {
    const toolCalls = deck();
    const ctx = makeCanonicalLoopContext({
      op: { id: opId },
      turnIdx: 2,
      currentUserMessage: "make a power point about Q3",
      toolCalls,
    });
    expect(officeThemeGuardMiddleware.afterModelCall!(ctx)).toEqual({ kind: "continue" });
    // It really did rewrite the call — the fire is not decorative.
    expect((toolCalls[0]!.args as Record<string, unknown>).theme).toBeUndefined();
    expect(firesOnDisk(opId)[0]!.body).toEqual({
      name: "office-theme-guard", reason: "office-theme-strip", outcome: "rewrite", turnIdx: 2,
    });
  });

  it("does not count a pass-through (nothing to strip)", () => {
    const ctx = makeCanonicalLoopContext({
      op: { id: opId },
      turnIdx: 2,
      currentUserMessage: "make a power point about Q3",
      toolCalls: [{ toolCallId: "t1", tool: "presentation", args: { action: "create" } }],
    });
    officeThemeGuardMiddleware.afterModelCall!(ctx);
    expect(firesOnDisk(opId)).toHaveLength(0);
  });
});


// The discriminator on its own. Every block above asserts it inside a whole-body
// `toEqual`, where a wrong shape surfaces as a body diff; these isolate it so a
// miscounted guard goes red under a test that NAMES the shape it should have had.
// Each drives the real code path — no GuardFire is hand-built here except where
// the production call site hand-builds one too.
describe("middleware_fired — `outcome` says WHAT the guard did", () => {
  const outcomes = (id: string): unknown[] =>
    firesOnDisk(id).map(e => (e.body as MiddlewareFiredBody).outcome);

  it("nudge: a post-commit nudge directive takes its shape from the directive kind", () => {
    applyCommittedDirective(op(), 2, {
      kind: "nudge", reason: "mid-turn-stale", firedBy: "mid-turn-stale", message: "Re-read the task.",
    }, EFFECTS);
    expect(outcomes(opId)).toEqual(["nudge"]);
  });

  it("abort: a guard that ENDED the turn is not filed as a nudge", () => {
    middlewareAbortResult(op(), 1, {
      kind: "abort", reason: "thrash-guard", firedBy: "thrash-guard", message: "Thrashing.",
    });
    expect(outcomes(opId)).toEqual(["abort"]);
  });

  it("suspend: the autonomous lane's pause is its own shape, not an abort", () => {
    suspendedTurn(opId, 1, {
      kind: "suspend", reason: "repeat-failure", firedBy: "repeat-failure", message: "Paused.",
    });
    expect(outcomes(opId)).toEqual(["suspend"]);
  });

  it("rewrite: a guard that edits the call instead of speaking is not a nudge", () => {
    const ctx = makeCanonicalLoopContext({
      op: { id: opId },
      turnIdx: 0,
      currentUserMessage: "make a power point about Q3",
      toolCalls: [{ toolCallId: "t1", tool: "presentation", args: { action: "create", theme: "scandal red" } }],
    });
    officeThemeGuardMiddleware.afterModelCall!(ctx);
    expect(outcomes(opId)).toEqual(["rewrite"]);
  });

  // The field's whole justification: banked together, these two fires agree on
  // name, reason AND turnIdx, so `outcome` is the only thing separating the
  // gate's retry nudge from the terminal it later authored. decide-outcome.test
  // drives the real chain; here the deferred half goes through the seam itself,
  // so this file's on-disk evidence covers both shapes.
  it("honest-terminal: banked, the gate's terminal is separable from its own nudge", () => {
    const LEAKED =
      "Searching.\n" +
      '<atem:function_calls><atem:invoke name="grep"><atem:parameter name="pattern">x</atem:parameter></atem:invoke></atem:function_calls>';
    const ctx = { op: op(), turnIdx: 0, toolCalls: [], assistantText: LEAKED };
    unresolvedToolIntentGate.evaluate(ctx);
    const settled = unresolvedToolIntentGate.evaluate({ ...ctx, turnIdx: 1 }) as CompletionGateOutput;
    // Exactly what decide-outcome contributes at the append and turn-loop
    // banks once the turn is durable.
    bankEarnedFires(opId, 1, settled.honestTerminal ? [settled.honestTerminal.fire] : []);

    expect(outcomes(opId)).toEqual(["nudge", "honest-terminal"]);
    const bodies = firesOnDisk(opId).map(e => e.body as MiddlewareFiredBody);
    expect(bodies.map(b => `${b.name}/${b.reason}/${b.turnIdx}`))
      .toEqual(["unresolved-tool-intent/unresolved-tool-intent/1", "unresolved-tool-intent/unresolved-tool-intent/1"]);
  });

  // The bug the seam exists to prevent, at the seam's own level: a gate NAMING
  // a fire writes nothing by itself. The two ways the effect can still not
  // happen — a later gate's reopen, and a Stop before commitTurn — are pinned
  // in decide-outcome.test.ts and turn-loop.test.ts respectively.
  it("a gate that merely NAMES a fire banks nothing on its own", () => {
    const LEAKED =
      "Searching.\n" +
      '<atem:function_calls><atem:invoke name="grep"><atem:parameter name="pattern">x</atem:parameter></atem:invoke></atem:function_calls>';
    unresolvedToolIntentGate.evaluate({ op: op(), turnIdx: 0, toolCalls: [], assistantText: LEAKED });
    const settled = unresolvedToolIntentGate.evaluate(
      { op: op(), turnIdx: 1, toolCalls: [], assistantText: LEAKED },
    ) as CompletionGateOutput;
    expect(settled.honestTerminal?.fire).toBeDefined();
    // Nobody appended the text and nobody banked, so the only row on disk is
    // the nudge — which was banked by the path that actually wrote it.
    expect(outcomes(opId)).toEqual(["nudge"]);
  });

  it("every shape the counter mints is in the closed vocabulary", () => {
    expect(OUTCOMES.sort())
      .toEqual(["abort", "gave-up", "honest-terminal", "nudge", "reopen", "repair", "rewrite", "suspend"]);
  });
});

// Sites the counter mints that NO test pinned: a sweep that set all five to
// deliberately absurd outcomes at once ran the full canonical-loop suite green.
// Three of them sit in the same gateSource(...) column as three that WERE
// pinned, so the gap was invisible on inspection — only mutation found it.
// Each case below drives the real producer and reads the real persisted row.
describe("middleware_fired — the sites a mutation sweep found unpinned", () => {
  const body = (id: string): MiddlewareFiredBody =>
    firesOnDisk(id)[0]!.body as MiddlewareFiredBody;
  const gate = (name: string): CompletionGate =>
    COMPLETION_GATES.find(g => g.name === name)!;
  const gateCtx = () => ({ op: op(), turnIdx: 2, toolCalls: [] as ToolCall[], assistantText: "" });

  it("spec-audit's nudge is counted under the gate's own name", async () => {
    expect((await gate("spec-audit").evaluate(gateCtx())).reopen).toBe(true);
    expect(body(opId)).toEqual({
      name: "spec-audit", reason: "spec-audit", outcome: "nudge", turnIdx: 3,
    });
  });

  it("design-verify's nudge is counted under the gate's own name", async () => {
    expect((await gate("design-verify").evaluate(gateCtx())).reopen).toBe(true);
    expect(body(opId)).toEqual({
      name: "design-verify", reason: "design-verify", outcome: "nudge", turnIdx: 3,
    });
  });

  it("earned-done's one-shot push is counted under the gate's own name", async () => {
    expect((await gate("earned-done").evaluate(gateCtx())).reopen).toBe(true);
    expect(body(opId)).toEqual({
      name: "earned-done", reason: "earned-done", outcome: "nudge", turnIdx: 3,
    });
  });

  // Not a gate and not a middleware — a transient provider throw recovered by
  // feeding the error back as a nudge. It builds its own GuardFire literal, so
  // it is one of the producers a helper-only change would have left shapeless.
  it("adapter-throw-recovery's resume nudge is counted", () => {
    const r = recoverAdapterThrow(op(), new Error("xai call threw: timeout"), 4);
    expect(r.terminalReason).toBeNull();
    expect(body(opId)).toEqual({
      name: "adapter-throw-recovery", reason: "adapter-retry", outcome: "nudge", turnIdx: 5,
    });
  });
});

// The four completion-gate branches that CHANGE BEHAVIOR while saying nothing
// to the model — before this, every one minted nothing, so a retirement review
// reading `middleware_fired` saw four dead guards steering live ops.
//
// They are NOT one case with four names, and the tests are structured to say
// so: two are counted AT THE BRANCH because their effect is already spent when
// `evaluate` returns (a registered dev server, dropped runtime errors), while
// the other two are still CONTINGENT there and ride the earned-fire seam — the
// build confirmation, whose append the epilogue decides (which is why the
// suppression case below is a test and not a comment), and the silent re-open,
// which is only an in-memory `terminalReason = null` until the turn commits.
describe("middleware_fired — the gate branches that act without speaking", () => {
  const gate = (name: string): CompletionGate => COMPLETION_GATES.find(g => g.name === name)!;
  const bodies = (id: string): MiddlewareFiredBody[] => firesOnDisk(id).map(e => e.body as MiddlewareFiredBody);
  /** A turn that wrote an app file — render-verify's trigger. */
  const APP_WRITE: ToolCall[] = [{ toolCallId: "t1", tool: "write", args: { path: "workspace/apps/todo/index.html" } }];
  const appOp = (): Op =>
    ({ id: opId, type: "app_build", task: "t", appUrl: "http://127.0.0.1:7007/apps/todo/index.html" }) as unknown as Op;

  beforeEach(() => { _resetInjectQueues(); });

  it("reopen: late-inject NAMES its silent re-open and mints nothing at the branch", async () => {
    // Real queue, real session bridge — the gate reads both directly.
    trackOpForSession(opId, `sess-${opId}`);
    pushInject(`sess-${opId}`, "actually, make it dark mode");

    const out = await gate("late-inject").evaluate({ op: op(), turnIdx: 4, toolCalls: [], assistantText: "" });

    expect(out.reopen).toBe(true);
    expect(out.reopenFire).toEqual({ name: "late-inject", reason: "late-inject", outcome: "reopen" });
    // NOTHING on disk yet. The veto is an in-memory `terminalReason = null` on
    // its way to a commitTurn driveTurn's cancel bail can skip, so a row
    // written here would assert a turn that never committed — the honest-
    // terminal rule, reached by the same argument.
    expect(firesOnDisk(opId)).toHaveLength(0);
  });

  it("reopen: the fire the gate named is the row the seam banks, under the vetoed turn", async () => {
    trackOpForSession(opId, `sess-${opId}`);
    pushInject(`sess-${opId}`, "actually, make it dark mode");
    const out = await gate("late-inject").evaluate({ op: op(), turnIdx: 4, toolCalls: [], assistantText: "" });

    // The chain runner contributes `out.reopenFire`, turn-loop.ts banks the
    // list after commitTurn. Driving the WHOLE chain here would trip the
    // spec-audit / design-verify stubs above, which re-open earlier; the live
    // ordering is proven end-to-end in test/inject-reopen-fires.contract.test.ts.
    bankEarnedFires(opId, 4, [out.reopenFire as GuardFire]);
    // turnIdx 4, not 5: the effect landed on THIS turn's terminal. The +1
    // convention is a nudge's, because a nudge is read on the next turn — and
    // nothing was appended here for the model to read.
    expect(bodies(opId)).toEqual([{ name: "late-inject", reason: "late-inject", outcome: "reopen", turnIdx: 4 }]);
  });

  it("late-inject with an empty queue is a `continue` verdict, and stays uncounted", async () => {
    trackOpForSession(opId, `sess-${opId}`);
    const out = await gate("late-inject").evaluate({ op: op(), turnIdx: 4, toolCalls: [], assistantText: "" });
    expect(out.reopen).toBe(false);
    expect(firesOnDisk(opId)).toHaveLength(0);
  });

  it("repair: framework-serve counts the dev server it actually registered", async () => {
    vi.mocked(finalizeFrameworkBuild).mockResolvedValueOnce({
      handled: true, ok: true, url: "http://127.0.0.1:7007/apps/todo/", framework: "vite", mode: "dev-server",
    });
    const out = await gate("framework-serve").evaluate({ op: appOp(), turnIdx: 2, toolCalls: [], assistantText: "" });
    expect(out.reopen).toBe(false);
    expect(bodies(opId)).toEqual([{ name: "framework-serve", reason: "framework-serve", outcome: "repair", turnIdx: 2 }]);
  });

  it("a FAILED registration is not a repair: the op ends with no server, which is what the gate exists to prevent", async () => {
    vi.mocked(finalizeFrameworkBuild).mockResolvedValueOnce({
      handled: true, ok: false, code: "dev_server_failed", message: "port busy",
    });
    const out = await gate("framework-serve").evaluate({ op: appOp(), turnIdx: 2, toolCalls: [], assistantText: "" });
    // `handled` alone only means the gate recognised a framework app. Counting
    // it would file a `repair` for a repair that did not happen; the attempt
    // survives as the warn line this branch logs.
    expect(out.reopen).toBe(false);
    expect(firesOnDisk(opId)).toHaveLength(0);
  });

  it("a static app never reaches the branch at all (handled:false — the hot path)", async () => {
    const out = await gate("framework-serve").evaluate({ op: appOp(), turnIdx: 2, toolCalls: [], assistantText: "" });
    expect(out.reopen).toBe(false);
    expect(firesOnDisk(opId)).toHaveLength(0);
  });

  it("gave-up: render-verify's cap is counted where the errors were DROPPED, not at a settled terminal", async () => {
    vi.mocked(runRenderVerifyGate).mockResolvedValueOnce({
      nudge: "TypeError: render is not a function", retryCount: 2, shouldRetry: false, capReached: true,
    });
    const out = await gate("render-verify").evaluate({ op: op(), turnIdx: 3, toolCalls: APP_WRITE, assistantText: "" });
    // The turn still ends "done" — the guard gave up on it, it did not abort it.
    expect(out.reopen).toBe(false);
    expect(bodies(opId)).toEqual([{ name: "render-verify", reason: "render-verify", outcome: "gave-up", turnIdx: 3 }]);
  });

  it("render-verify that observed nothing banks nothing", async () => {
    const out = await gate("render-verify").evaluate({ op: op(), turnIdx: 3, toolCalls: APP_WRITE, assistantText: "" });
    expect(out.reopen).toBe(false);
    expect(firesOnDisk(opId)).toHaveLength(0);
  });

  // Build-verify's confirmation: the one of the four that SPEAKS, and the one
  // whose fire cannot be minted at the gate. `verifiedClean` is settled turns
  // earlier; whether the user ever sees the green line is settled here.
  const CONFIRMATION = "✓ Verified: the harness ran `npm run build` and it passed with no errors.";
  const runEpilogue = (fires: GuardFire[]): CommitTurnMessage[] => {
    const allMessages: CommitTurnMessage[] = [];
    applyTerminalEpilogue({
      op: op(), turnIdx: 6, terminalReason: "done", assistantText: "All set.",
      buildVerifyConfirmation: CONFIRMATION, toolCalls: [], observedTools: [],
    }, allMessages, fires);
    return allMessages;
  };
  /** `build-verify-ok-<opId>-<turn>-<uuid>` → `build-verify-ok`. */
  const kinds = (messages: CommitTurnMessage[]): string[] =>
    messages.map(m => (m.messageId ?? "").split("-").slice(0, 3).join("-"));

  it("honest-terminal: build-verify's green confirmation is counted at its APPEND, under its own gate name", () => {
    const fires: GuardFire[] = [];
    expect(kinds(runEpilogue(fires))).toEqual(["build-verify-ok"]);
    // Exactly what decide-outcome returns and turn-loop banks post-commit.
    bankEarnedFires(opId, 6, fires);
    // Same shape as the gate terminal beside it — one act, one label. `name` is
    // what separates the two producers of `honest-terminal`.
    expect(bodies(opId)).toEqual([{ name: "build-verify", reason: "build-verify", outcome: "honest-terminal", turnIdx: 6 }]);
  });

  it("SUPPRESSED: a partial-ending op shows no green line, so it banks NO fire", () => {
    // The loud-partial warning wins: `!endedPartial` is false, the confirmation
    // is never appended, and the user is never shown it. A fire banked at the
    // gate — where `verifiedClean` was decided — would count this terminal
    // anyway. That miscount is the whole reason this one branch is deferred.
    vi.mocked(openStepsTerminationWarning).mockReturnValueOnce("Heads up: 2 steps are still open.");
    const fires: GuardFire[] = [];
    expect(kinds(runEpilogue(fires))).toEqual(["open-steps-warn"]);
    expect(fires).toEqual([]);
    bankEarnedFires(opId, 6, fires);
    expect(firesOnDisk(opId)).toHaveLength(0);
  });
});
