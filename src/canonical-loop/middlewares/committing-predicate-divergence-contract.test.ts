/**
 * CROSS-SEAM CONTRACT: the committing registry answers THREE questions, not
 * one. This file goes red the moment any two of them are unified.
 *
 * Every regression in this area came from an author who read two of these
 * predicates, saw the same registry underneath, and merged them. Comments did
 * not hold the line — four of them shipped while being false about their own
 * code. So the distinction is pinned here, executably:
 *
 *   Q1 REPLAY / ABORT SAFETY — "might this call have LANDED, such that redoing
 *      it would double-execute?"  Owner: turn-loop/dispatch-tools.ts, which
 *      stamps isCommittingCall(tool, args) and hands it to
 *      session/turn-lock.ts:beginToolRound BEFORE the tool body runs, then
 *      settles it against the result (only `declined` unlatches — NEVER_LANDED).
 *      Consumer: tryAcquireOrReplace, i.e. "may a second user message abort and
 *      replace this turn?".
 *
 *   Q2 PROGRESS GATING — "did this op do work on the USER'S request?"
 *      Owner: committing-tool-check.ts:opCommittedSubstantiveWork /
 *      rowCommittedSubstantiveWork, projected onto
 *      ctx.substantiveCommittingToolsThisOp by host.ts. Consumers: open-steps,
 *      premature-completion, refute-completion.
 *
 *   Q3 LIVENESS — "is there ANY side effect on record I'd be aborting on top
 *      of?"  Owner: ctx.committingToolsThisOp, the name-only tally. Consumer:
 *      mid-turn-stale's circuit breaker, whose second strike ABORTS.
 *
 * Nothing in the type system separates them: all three bottom out in the same
 * tool-registry risk tiers, and two of them are `Set<string>` fields on the same
 * context object. This file is the separation.
 *
 * Not duplicated here (already pinned): committed-work-union-contract.test.ts
 * pins `raw || substantive === opCommittedWork` plus the registry-wide sweep;
 * dispatch-tools.turn-lock.test.ts pins each dispatch status against the lock in
 * isolation. What is new below is the DISAGREEMENT between the questions for one
 * and the same call, and the real gates' behavior on a ledger-only op.
 *
 * Style note: contexts come from the real host builder over rows the real
 * dispatcher produced, and Ops from ctx.test-helper — never `as unknown as`.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const { openTasksMock, refuteClaimMock } = vi.hoisted(() => ({
  openTasksMock: vi.fn<(sessionId: string) => Array<{ id: string; description: string }>>(),
  refuteClaimMock: vi.fn(),
}));
// Both mocks are COMPLETE (every runtime export of the module), so they stay
// safe for the whole dispatch import graph, not just the middleware under test.
vi.mock("../../tools/task-tools.js", () => ({
  taskTools: [],
  getOpenTasksForSession: openTasksMock,
}));
vi.mock("../../classifiers/refute-claim.js", () => ({ refuteClaim: refuteClaimMock }));

import { dispatchTools } from "../turn-loop/dispatch-tools.js";
import { registerToolDispatcherForOp, unregisterToolDispatcherForOp } from "../runtime.js";
import { functionToolDispatcher } from "../tool-dispatch.js";
import { writeOp } from "../../ops/op-store.js";
import { insertOpTurn } from "../store.js";
import { trackOpForSession, releaseOpFromSession } from "../../ops/session-bridge.js";
import {
  getTurnRegistry,
  getActiveTurn,
  releaseTurn,
  tryAcquireOrReplace,
} from "../../session/turn-lock.js";
import { buildCanonicalLoopContext } from "./host.js";
import { makeCanonicalLoopContext } from "./ctx.test-helper.js";
import { openStepsMiddleware } from "./open-steps.js";
import { prematureCompletionMiddleware } from "./premature-completion.js";
import { refuteCompletionMiddleware } from "./refute-completion.js";
import { midTurnStaleMiddleware } from "./mid-turn-stale.js";
import { _resetMiddlewareStates } from "./state.js";
import { opCommittedSubstantiveWork } from "../../committing-tool-check.js";
import type { ToolCallSummary, ToolDispatchStatus } from "../types.js";
import type { CanonicalLoopContext, CanonicalMiddlewareResult } from "./types.js";
import type { Op } from "../../ops/types.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const EMAIL_ARGS = { to: "a@b.test", subject: "invoice #41", body: "attached" };

let seq = 0;
const opIds: string[] = [];
const sessions: string[] = [];

/** A complete Op, persisted so dispatchTools can read it back. ctx.test-helper
 *  is the ONE cast-free source of a complete Op — hand-building one and casting
 *  is the footgun this campaign already closed. */
function makeOp(over: Record<string, unknown> = {}): Op {
  const id = `op_divergence_${seq++}_${process.pid}`;
  opIds.push(id);
  const op = makeCanonicalLoopContext({
    op: { id, model: "test-model", createdAt: new Date().toISOString(), ...over },
  }).op;
  writeOp(op);
  return op;
}

function session(label: string): string {
  const id = `s-divergence-${label}-${process.pid}-${seq++}`;
  sessions.push(id);
  return id;
}

/** Run real tool dispatch and hand back the summary rows it persists. Every row
 *  below is produced this way — never hand-forged — so the `committing` stamp is
 *  whatever dispatch actually writes. */
async function dispatch(
  op: Op,
  calls: Array<{ tool: string; args: unknown }>,
  statusFor: (tool: string) => ToolDispatchStatus = () => "ok",
): Promise<ToolCallSummary[]> {
  registerToolDispatcherForOp(op.id, functionToolDispatcher(async (c) => ({
    status: statusFor(c.tool),
    result: `ran:${c.tool}`,
  })));
  try {
    const out = await dispatchTools(
      op.id,
      0,
      calls.map((c, i) => ({ toolCallId: `tc-${seq++}-${i}`, tool: c.tool, args: c.args })),
    );
    return out.toolSummary;
  } finally {
    unregisterToolDispatcherForOp(op.id);
  }
}

/** Persist rows as this op's turn 0, so every ctx built for it afterwards gets
 *  its tallies from host.ts's real projection rather than a fixture's guess. */
function persist(op: Op, rows: ToolCallSummary[]): void {
  insertOpTurn({
    opId: op.id,
    turnIdx: 0,
    providerState: { adapterName: "test", adapterVersion: "0", providerPayload: null },
    toolCallSummary: rows,
    terminalReason: null,
    redirectConsumed: false,
    createdAt: new Date().toISOString(),
  });
}

function ctxFor(op: Op, turnIdx = 0, evidenceHistory: number[] = []): CanonicalLoopContext {
  return buildCanonicalLoopContext({
    op,
    turnIdx,
    assistantContent: "All set — here's what I found.",
    toolCalls: [],
    evidenceHistory,
  });
}

function contextOver(op: Op, rows: ToolCallSummary[]): CanonicalLoopContext {
  persist(op, rows);
  return ctxFor(op);
}

/** The three completion gates, run in stack order against one context. */
async function runGates(ctx: CanonicalLoopContext): Promise<Record<string, CanonicalMiddlewareResult>> {
  const out: Record<string, CanonicalMiddlewareResult> = {};
  for (const mw of [openStepsMiddleware, prematureCompletionMiddleware, refuteCompletionMiddleware]) {
    out[mw.name] = mw.when && !mw.when(ctx)
      ? { kind: "continue" }
      : await mw.afterModelCall!(ctx);
  }
  return out;
}

beforeEach(() => {
  _resetMiddlewareStates();
  openTasksMock.mockReset();
  openTasksMock.mockReturnValue([]);
  refuteClaimMock.mockReset();
  refuteClaimMock.mockResolvedValue({ refuted: false, verdict: {}, summary: "0/3", reasons: [] });
});

afterEach(() => {
  for (const s of sessions) releaseTurn(s);
  for (const id of opIds) releaseOpFromSession(id);
});

afterAll(() => {
  for (const id of opIds) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
});

describe("Q1 (replay safety) vs Q2 (progress) — the errored email_send", () => {
  /** A chat turn holding its session's lock, plus one email_send dispatched
   *  with `status`. Returns both the lock's Q1 verdict and the row Q2 reads. */
  async function sendEmail(status: ToolDispatchStatus) {
    const sessionId = session(`email-${status}`);
    const op = makeOp({ type: "chat_turn", canonical: { flagValue: true, state: "running", sessionId } });
    expect(getTurnRegistry().acquireTurn(sessionId, new AbortController(), "prior")).toBe(true);
    const rows = await dispatch(op, [{ tool: "email_send", args: EMAIL_ARGS }], () => status);
    // Q1, read at its live consumer: did the lock treat the call as possibly
    // landed, so a second user message cannot abort-and-replay this turn?
    const mightHaveLanded = getActiveTurn(sessionId)?.hasCommitted ?? false;
    const pending = tryAcquireOrReplace(sessionId, new AbortController(), "second-message");
    releaseTurn(sessionId); // stands in for the aborted handler finishing its commit
    const decision = await pending;
    return {
      rows,
      mightHaveLanded,
      refusedReplacement: decision.reason === "refused-committing",
      // Q2, over the exact row dispatch persisted for this call.
      didWork: opCommittedSubstantiveWork([{ toolCallSummary: rows }]),
    };
  }

  it("says LANDED and NO-WORK for the same call — and that disagreement is CORRECT", async () => {
    const r = await sendEmail("error");
    expect(r.rows[0].resultStatus).toBe("error");
    expect(r.rows[0].committing).toBe(true);

    // Q1: `error` is decided DURING or AFTER the tool body — email-send's catch
    // spans the transport send and the bookkeeping after it, so the mail may
    // already be delivered. The turn must not be replaced; replacement re-sends.
    expect(r.mightHaveLanded).toBe(true);
    expect(r.refusedReplacement).toBe(true);

    // Q2: the same call reported failure, so it is NOT evidence the op made
    // progress on the user's request. A completion gate that counted it would
    // let "I tried to email them" stand in for "I emailed them".
    expect(r.didWork).toBe(false);

    // ─────────────────────────────────────────────────────────────────────
    // THE CONTRACT: those two answers contradict each other on purpose and
    // must NEVER be reconciled. Q1 is conservative because the cost of being
    // wrong is a double-send; Q2 is strict because the cost of being wrong is a
    // false "done". Unifying them breaks one direction whichever way you go:
    // adding `error` to NEVER_LANDED re-sends the mail; dropping
    // rowCommittedWork's resultStatus gate credits refused work as work.
    // ─────────────────────────────────────────────────────────────────────
  });

  it("control: a LANDED email_send reads as work on both questions", async () => {
    // Proves the Q2 assertion above can fail — `didWork` is not stuck false.
    const r = await sendEmail("ok");
    expect(r.mightHaveLanded).toBe(true);
    expect(r.refusedReplacement).toBe(true);
    expect(r.didWork).toBe(true);
  });

  it("control: a DECLINED email_send is the one status that never landed", async () => {
    // Proves the Q1 assertion can fail — `mightHaveLanded` is not stuck true.
    // `declined` is refused by the approval gate strictly BEFORE the tool body,
    // so it is the sole member of NEVER_LANDED and the turn stays replaceable.
    const r = await sendEmail("declined");
    expect(r.mightHaveLanded).toBe(false);
    expect(r.refusedReplacement).toBe(false);
    expect(r.didWork).toBe(false);
  });
});

describe("Q3 (liveness) vs Q2 (progress) — the ledger-only op", () => {
  it("counts a task_create for the abort brake and NOT for the completion gates", async () => {
    const op = makeOp({ lane: "interactive" });
    const rows = await dispatch(op, [{ tool: "task_create", args: { description: "step 1" } }]);
    const ctx = contextOver(op, rows);

    // Q3: task_create was deliberately given a committing risk tier so the
    // mid-turn brake would stop aborting turns mid-plan. Ledger INCLUDED.
    expect([...ctx.committingToolsThisOp]).toEqual(["task_create"]);
    // Q2: the same call is the op's own planning, not work on the user's
    // request. Crediting it makes every completion gate cite itself.
    expect([...ctx.substantiveCommittingToolsThisOp]).toEqual([]);
    // Collapsing either set into the other is the regression this pins.
    expect(ctx.committingToolsThisOp).not.toEqual(ctx.substantiveCommittingToolsThisOp);
  });

  it("keeps mid-turn-stale from aborting a turn that only planned", async () => {
    // The real consumer of Q3, at the point where it hurts: an interactive
    // turn's SECOND strike returns {kind:"abort"}. A ledger-only op must reach
    // the stand-down before Branch 1 ever runs.
    const op = makeOp({ lane: "interactive" });
    persist(op, await dispatch(op, [{ tool: "task_create", args: { description: "step 1" } }]));
    for (const turnIdx of [5, 6]) {
      const ctx = ctxFor(op, turnIdx, [7, 7, 7]);
      expect(await midTurnStaleMiddleware.beforeTurn!(ctx)).toEqual({ kind: "continue" });
    }
  });

  it("control: the same brake DOES abort when nothing committed", async () => {
    // Proves the assertion above is not vacuous — with a read-only op the
    // second strike fires, so the ledger row is what silenced it.
    const op = makeOp({ lane: "interactive" });
    persist(op, await dispatch(op, [{ tool: "read", args: { file_path: "a.txt" } }]));
    const ctx5 = ctxFor(op, 5, [7, 7, 7]);
    expect(ctx5.committingToolsThisOp.size).toBe(0);
    expect(await midTurnStaleMiddleware.beforeTurn!(ctx5)).toEqual({ kind: "continue" });
    expect((await midTurnStaleMiddleware.beforeTurn!(ctxFor(op, 6, [7, 7, 7]))).kind).toBe("abort");
  });
});

describe("the completion gates never mistake an op's own ledger for work", () => {
  /** A worker op with open steps on record, driven through all three gates. */
  async function gatesOver(label: string, calls: Array<{ tool: string; args: unknown }>) {
    const sessionId = session(label);
    const op = makeOp({ lane: "agent" });
    trackOpForSession(op.id, sessionId);
    openTasksMock.mockImplementation((s) =>
      s === sessionId ? [{ id: "t1", description: "Wire the parser" }] : []);
    const ctx = contextOver(op, await dispatch(op, calls));
    return { ctx, results: await runGates(ctx) };
  }

  const READ_ONLY = [
    { tool: "read", args: { file_path: "contract.md" } },
    { tool: "task_create", args: { description: "Wire the parser" } },
  ];

  it("a read-only op that only planned: no gate treats the plan as progress", async () => {
    const { ctx, results } = await gatesOver("readonly", READ_ONLY);
    expect([...ctx.substantiveCommittingToolsThisOp]).toEqual([]);

    // Q2 at open-steps: the task_* calls that OPENED these steps must not be the
    // evidence that more work is owed — that reasoning is circular, and it is
    // what made a read-only "summarize these contracts" turn pay a second
    // round-trip to tick checkboxes.
    expect(results["open-steps"]).toEqual({ kind: "continue" });
    // Q2 at refute-completion: a planning-only op has nothing to refute, so no
    // LLM skeptic panel is bought for it.
    expect(results["refute-completion"]).toEqual({ kind: "continue" });
    expect(refuteClaimMock).not.toHaveBeenCalled();
    // Q2 at premature-completion fires in the OPPOSITE direction: a worker that
    // wrote a to-do list and nothing else IS the no-action case this gate
    // exists to push. Unifying Q2 with Q3 would silence it here — so this
    // assertion is a nudge, not a continue, on purpose.
    //
    // ── KNOWN LIMIT — DELETE-ME-WHEN-FIXED (this marker; UPDATE the assertion
    //    below, never delete it) ───────────────────────────────────────────
    // PINNED: today's behavior, not a settled specification. A worker op whose
    // only committing call was its OWN task_create nudges here even when the
    // op was read-only BY DESIGN ("research X and write me a summary").
    // WHY DOUBTFUL: for that op shape the nudge is unanswerable. Its text —
    // "nothing has been written, saved, or changed … do it now using the
    // available tools" (premature-completion.ts) — demands a change the user
    // never asked for, so the op can only re-affirm and burn the extra turn.
    // It is the SAME false positive detectUncommittedTurn was fixed for
    // earlier in this campaign (agent-loop-detectors/detectors.ts, whose
    // UNCOMMITTED_TURN_INSTRUCTION told a browse-and-report op to call
    // "write/edit/send/save"); that fix read the RAW ∪ SUBSTANTIVE union
    // precisely so the task_* ledger keeps a read-only op standing down.
    // premature-completion.ts:42 moved the OTHER way in this same campaign —
    // from ctx.committingToolsThisOp to ctx.substantiveCommittingToolsThisOp —
    // so the two gates now answer differently about one identical op.
    // Measured, not assumed, over this fixture's rows:
    // isCommittingTool("task_create") === true (old predicate → continue, no
    // nudge) while rowCommittedSubstantiveWork(task_create row) === false (new
    // predicate → the nudge asserted below).
    // WHAT WOULD FIX IT: a "did the user ask for a change?" signal, which does
    // NOT exist in the codebase — detectors.ts records the same missing signal
    // as its own honest limit. capabilityForbiddenForOp(op, "workspace-write")
    // is the nearest thing and is not it: it needs an EXPLICIT user
    // prohibition ("read-only", "don't change anything"), never an inferred
    // read-only request.
    // WHEN THAT SIGNAL LANDS: UPDATE this assertion — expect `continue` for an
    // op the user asked no change of, and keep a nudge case for a
    // change-requesting op that only planned. Do NOT delete it: the Q2-vs-Q3
    // separation it also pins (an op's own to-do list is never progress on the
    // user's request) stays correct either way, and dropping it re-opens the
    // exact regression this file exists to catch.
    // ─────────────────────────────────────────────────────────────────────
    expect(results["premature-completion"]).toMatchObject({
      kind: "nudge",
      reason: "premature-completion",
    });
  });

  it("control: the same op with real work flips every gate the other way", async () => {
    refuteClaimMock.mockResolvedValue({ refuted: true, verdict: {}, summary: "3/3", reasons: ["no tests"] });
    const { ctx, results } = await gatesOver("worked", [
      ...READ_ONLY,
      { tool: "write", args: { file_path: "parser.ts", content: "x" } },
    ]);
    expect([...ctx.substantiveCommittingToolsThisOp]).toEqual(["write"]);

    // Without this control, "nothing fires" above would also pass with all
    // three gates broken.
    expect(results["open-steps"]).toMatchObject({ kind: "nudge", reason: "open-steps" });
    expect(results["premature-completion"]).toEqual({ kind: "continue" });
    expect(results["refute-completion"]).toMatchObject({ kind: "nudge", reason: "refute-completion" });
    expect(refuteClaimMock).toHaveBeenCalled();
  });

  it("a read-only INTERACTIVE turn is never forced to keep working", async () => {
    // The two worker-only gates are excluded by lane, and open-steps — which
    // does run on chat — stands down on the same Q2 signal. So the read-only
    // chat turn ends when the user's answer is ready.
    const sessionId = session("chat-readonly");
    const op = makeOp({ lane: "interactive" });
    trackOpForSession(op.id, sessionId);
    openTasksMock.mockImplementation((s) =>
      s === sessionId ? [{ id: "t1", description: "Wire the parser" }] : []);
    const rows = await dispatch(op, READ_ONLY);
    const results = await runGates(contextOver(op, rows));
    for (const name of Object.keys(results)) {
      expect(results[name], name).toEqual({ kind: "continue" });
    }
  });
});
