/**
 * The `reopen` outcome's TWO producers, on real ops driven through the real
 * loop (canonicalLoopEntry → scheduler → worker → turn-loop → real
 * completion-gate chain → real commitTurn → real canonical-events.jsonl).
 *
 * A user follow-up that lands while a turn is wrapping up vetoes that turn's
 * terminal and drives another turn with NOTHING said to the model. The harness
 * performs that veto from TWO sites, chosen purely by when the message arrived:
 *
 *   decide-outcome.ts's continuation guard   the inject was already queued when
 *                                            decideTurnOutcome ran
 *   decide-outcome-gates.ts's late-inject    it landed DURING the async verify
 *                                            gates, which each await
 *
 * Both are counted, under different `name`s, and both ride the earned-fire
 * seam — the veto's whole effect is an in-memory `terminalReason = null` on its
 * way to a `commitTurn` a Stop can cancel, so a row banked before that commit
 * asserts a turn that never existed. guard-fire.ts carries the ledger; this
 * file is the contract, read off the durable event log.
 *
 * WHAT IS FAKED: the per-op adapter (registerAdapterForOp), the tool dispatcher
 * (setToolDispatcher), and the three completion gates whose work is an EXTERNAL
 * process (build-verify spawns the project's own build; spec-probe and
 * spec-audit each make a provider call). The inject queue, the session bridge,
 * the gate objects, the chain runner, decide-outcome, the cancel bail, the fire
 * seam and the event log are all real.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Scripted EXTERNAL checks. Partial mocks: terminal-epilogue.ts imports
// groundTruthSizesNote from build-verify.js and must keep the real one.
vi.mock("../src/canonical-loop/turn-loop/build-verify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/canonical-loop/turn-loop/build-verify.js")>()),
  runBuildVerifyGate: vi.fn(async () => ({
    nudge: "", shouldRetry: false, capReached: false, verifiedClean: false, confirmation: "",
  })),
}));
vi.mock("../src/canonical-loop/turn-loop/spec-probes.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/canonical-loop/turn-loop/spec-probes.js")>()),
  runSpecProbeGate: vi.fn(async () => ({ nudge: "", shouldRetry: false })),
}));
vi.mock("../src/canonical-loop/turn-loop/spec-audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/canonical-loop/turn-loop/spec-audit.js")>()),
  runSpecAuditGate: vi.fn(async () => ({ nudge: "", shouldRetry: false })),
}));

import {
  canonicalLoopEntry,
  registerAdapterForOp,
  setToolDispatcher,
  functionToolDispatcher,
  awaitCanonicalOp,
  awaitIdle,
  opCancel,
  readCanonicalEvents,
  resetCanonicalRuntime,
  resetScheduler,
} from "../src/canonical-loop/index.js";
import { setMiddlewareStack, _resetMiddlewareStack } from "../src/canonical-loop/middlewares/host.js";
import { verifyGateMiddleware } from "../src/canonical-loop/middlewares/verify-gate.js";
import { runBuildVerifyGate } from "../src/canonical-loop/turn-loop/build-verify.js";
import { _resetInjectQueues, pushInject } from "../src/agent-loop/inject-queue.js";
import { trackOpForSession } from "../src/ops/session-bridge.js";
import { newOpId, readOp } from "../src/ops/op-store.js";
import type { Op } from "../src/ops/types.js";
import type { Adapter, AdapterReport, TurnInput, TurnResult } from "../src/canonical-loop/adapter-contract.js";
import type { ToolCall } from "../src/canonical-loop/contract-types.js";
import type { CanonicalMiddleware } from "../src/canonical-loop/middlewares/types.js";
import type { MiddlewareFiredBody } from "../src/canonical-loop/types.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];

/** A source edit, so build-verify's entry condition (opEditedSourceUnverified)
 *  is satisfied by the REAL verify-gate middleware watching a REAL dispatch —
 *  the only way to make an AWAITING gate run, which is the window late-inject
 *  exists for. */
const SOURCE_WRITE: ToolCall = {
  toolCallId: "ri-write-1",
  tool: "write",
  args: { path: "src/ri-probe.ts", content: "export const a = 1;\n" },
};
const READ_CALL: ToolCall = { toolCallId: "ri-read-1", tool: "read", args: { path: "src/nope.ts" } };

// ── Op factory ───────────────────────────────────────────────────────────

/** `chat_turn`, because opConsumesInjects gates every site under test on it. */
function mkOp(label: string): Op {
  const id = newOpId(`ri_${label}_${randomUUID().slice(0, 6)}`);
  const task = "Do the thing.";
  tracked.push(id);
  return {
    id,
    type: "chat_turn",
    task,
    contextPack: {
      task: { description: task, successCriteria: [], constraints: [], notWhatToRedo: [] },
      context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" },
      capabilities: {},
      budget: { maxIterations: 10, maxTokens: 0, maxWallTimeMs: 0, maxSelfEditCalls: 0 },
      routing: { lane: "interactive" },
      secrets: { allowed: [] },
    },
    lane: "interactive",
    retryPolicy: { maxRecoveryAttempts: 1, backoffMs: [0] },
    ownerId: "local-user",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
    model: "fake-test-model",
  } as unknown as Op;
}

// ── Adapters ─────────────────────────────────────────────────────────────

const providerState = { adapterName: "ri-fake", adapterVersion: "1", providerPayload: null };

function finalize(report: (r: AdapterReport) => void, id: string, text: string, calls?: ToolCall[]): void {
  report({
    kind: "message_finalized",
    message: { messageId: id, role: "assistant", content: calls ? { text, toolCalls: calls } : { text } },
  });
}

/** Edits source and finishes in ONE turn, so the awaiting build-verify gate
 *  really runs. The write rides the same turn as the final text on purpose:
 *  verify-gate's own wrap-up nudge is skipped on a turn carrying tool calls, so
 *  no middleware nudge re-opens the turn ahead of the gate chain. */
function editingAdapter(seen: number[] = []): Adapter {
  return {
    name: "ri-edit",
    version: "1",
    async runTurn(input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult> {
      seen.push(input.turnIdx);
      report({ kind: "tool_call_requested", call: SOURCE_WRITE });
      finalize(report, `ri-am-edit-${input.turnIdx}`, "Wrote the module. All set.", [SOURCE_WRITE]);
      return { providerState, terminalReason: "done", modelStop: "ended" };
    },
    async abort(): Promise<void> { /* scripted turns unwind immediately */ },
  };
}

/** Says "done" every turn with no tool calls at all. */
function plainDoneAdapter(seen: number[] = []): Adapter {
  return {
    name: "ri-plain",
    version: "1",
    async runTurn(input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult> {
      seen.push(input.turnIdx);
      finalize(report, `ri-am-${input.turnIdx}`, "All done.");
      return { providerState, terminalReason: "done", modelStop: "ended" };
    },
    async abort(): Promise<void> { /* scripted turns unwind immediately */ },
  };
}

/** Turn 0 makes ONE call the dispatcher fails, then claims done — the
 *  gaslighting shape decide-outcome's failure nudge exists for. Later turns
 *  are tool-less so the op can settle. */
function failingCallAdapter(seen: number[] = []): Adapter {
  return {
    name: "ri-fail",
    version: "1",
    async runTurn(input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult> {
      seen.push(input.turnIdx);
      if (input.turnIdx === 0) {
        report({ kind: "tool_call_requested", call: READ_CALL });
        finalize(report, "ri-am-fail-0", "Read the file. All set.", [READ_CALL]);
      } else {
        finalize(report, `ri-am-fail-${input.turnIdx}`, "Sorry — that call failed.");
      }
      return { providerState, terminalReason: "done", modelStop: "ended" };
    },
    async abort(): Promise<void> { /* scripted turns unwind immediately */ },
  };
}

// ── Middlewares ──────────────────────────────────────────────────────────

/** A user follow-up typed BEFORE decideTurnOutcome runs — the continuation
 *  guard's window. afterToolExecution is the last phase before it. */
function injectOnTurnMiddleware(turnIdx: number, sessionId: string): CanonicalMiddleware {
  return {
    name: "ri-inject",
    afterToolExecution(ctx) {
      if (ctx.turnIdx === turnIdx) pushInject(sessionId, "actually, make it dark mode");
      return { kind: "continue" };
    },
  };
}

/** A plain middleware nudge — the continuation guard's OTHER re-opening
 *  branch, whose row appendNudgeAsUserMessage already writes. */
function nudgeOnTurnMiddleware(turnIdx: number): CanonicalMiddleware {
  return {
    name: "ri-nudger",
    afterToolExecution(ctx) {
      if (ctx.turnIdx !== turnIdx) return { kind: "continue" };
      return { kind: "nudge", message: "Say more about the tradeoff.", reason: "ri-nudge-reason" };
    },
  };
}

// ── Read helpers ─────────────────────────────────────────────────────────

interface FiredEvent extends MiddlewareFiredBody { seq: number }

function firesFor(opId: string): FiredEvent[] {
  return readCanonicalEvents(opId)
    .filter(e => e.type === "middleware_fired")
    .map(e => ({ seq: e.seq, ...(e.body as unknown as MiddlewareFiredBody) }));
}

/** `seq` of `turn_committed` for one turn (-1 when the turn never committed) —
 *  the durability line the earned-fire seam is defined against. */
function commitSeq(opId: string, turnIdx: number): number {
  const row = readCanonicalEvents(opId)
    .find(e => e.type === "turn_committed" && (e.body as { turnIdx?: number })?.turnIdx === turnIdx);
  return row?.seq ?? -1;
}

async function drive(op: Op, adapter: () => Adapter): Promise<void> {
  registerAdapterForOp(op.id, adapter);
  canonicalLoopEntry(op);
  const result = await awaitCanonicalOp(op.id, 15_000);
  expect(result, `op ${op.id} never reached a terminal state`).not.toBeNull();
  await awaitIdle(5_000);
}

async function waitForState(opId: string, state: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (readOp(opId)?.canonical?.state === state) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`op ${opId} never reached ${state}; current=${readOp(opId)?.canonical?.state}`);
}

beforeEach(() => {
  _resetInjectQueues();
  // Call history only — the factory implementations survive, and the two
  // per-test scripts below are re-applied straight after.
  vi.clearAllMocks();
  setToolDispatcher(functionToolDispatcher(async () => ({ status: "ok" as const, result: { ok: true } })));
  vi.mocked(runBuildVerifyGate).mockResolvedValue({
    nudge: "", shouldRetry: false, capReached: false, verifiedClean: false, confirmation: "",
  });
});

afterEach(async () => {
  await awaitIdle(3_000).catch(() => undefined);
  _resetMiddlewareStack();
  _resetInjectQueues();
});

afterAll(() => {
  resetScheduler();
  resetCanonicalRuntime();
  for (const id of tracked) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});

/** Land a user follow-up INSIDE build-verify's await — the seconds-to-minutes
 *  window the late-inject gate exists for — optionally with a Stop alongside
 *  it, which is the same window turn-loop.ts's cancel bail exists for. */
function injectInsideTheGateWindow(opId: string, sessionId: string, alsoStop: boolean): void {
  vi.mocked(runBuildVerifyGate).mockImplementationOnce(async () => {
    pushInject(sessionId, "actually, make it dark mode");
    if (alsoStop) opCancel(opId, "ri-user-stop");
    return { nudge: "", shouldRetry: false, capReached: false, verifiedClean: false, confirmation: "" };
  });
}

// ── (a) a Stop landing in the verify-gate window ─────────────────────────

describe("reopen (a) — a Stop in the verify-gate window banks NO `reopen` row", () => {
  it("records no veto for a turn the cancel bail threw away", async () => {
    setMiddlewareStack([verifyGateMiddleware]);
    const op = mkOp("stopped");
    const sessionId = `sess-${op.id}`;
    trackOpForSession(op.id, sessionId);
    // Both land in the SAME window: the user types a follow-up during the
    // verify gates and hits Stop. late-inject sees the inject and vetoes the
    // terminal; driveTurn's cancel bail then discards the whole turn.
    injectInsideTheGateWindow(op.id, sessionId, true);

    const seen: number[] = [];
    registerAdapterForOp(op.id, () => editingAdapter(seen));
    canonicalLoopEntry(op);
    await waitForState(op.id, "cancelled");
    await awaitIdle(5_000);

    // NON-VACUOUS, three ways. The awaiting gate really ran (so the window is
    // real)...
    expect(vi.mocked(runBuildVerifyGate)).toHaveBeenCalled();
    // ...turn 0 really ran...
    expect(seen).toEqual([0]);
    // ...and it never committed, so no turn exists for a veto to be about.
    expect(commitSeq(op.id, 0)).toBe(-1);
    expect(readOp(op.id)?.canonical?.state).toBe("cancelled");

    // THE CLAIM. A `reopen` row asserts (types.ts GuardOutcome) that a gate
    // "VETOED the terminal and drove another turn" — on a cancelled op whose
    // turn never committed and whose next turn never ran, that is false.
    expect(firesFor(op.id).filter(f => f.outcome === "reopen")).toEqual([]);
  }, 30_000);

  it("...but the SAME inject with no Stop is counted, after the commit", async () => {
    // Non-vacuity for the test above: the fire is deferred, not deleted.
    setMiddlewareStack([verifyGateMiddleware]);
    const op = mkOp("late");
    const sessionId = `sess-${op.id}`;
    trackOpForSession(op.id, sessionId);
    injectInsideTheGateWindow(op.id, sessionId, false);

    const seen: number[] = [];
    await drive(op, () => editingAdapter(seen));

    // The veto really drove another turn.
    expect(seen).toEqual([0, 1]);
    const reopens = firesFor(op.id).filter(f => f.outcome === "reopen");
    expect(reopens.map(f => `${f.name}/${f.reason}/${f.turnIdx}`))
      .toEqual(["late-inject/late-inject/0"]);
    // Banked past the cancel bail, on the durable turn — the seam's whole point.
    expect(commitSeq(op.id, 0)).toBeGreaterThan(-1);
    expect(reopens[0]!.seq).toBeGreaterThan(commitSeq(op.id, 0));
  }, 30_000);
});

// ── (b) the continuation guard's silent veto ─────────────────────────────

describe("reopen (b) — the continuation guard's inject veto banks a `reopen` row", () => {
  it("counts the inject that arrived BEFORE the gates, the half that ran silent", async () => {
    const op = mkOp("guard");
    const sessionId = `sess-${op.id}`;
    trackOpForSession(op.id, sessionId);
    setMiddlewareStack([injectOnTurnMiddleware(0, sessionId)]);

    const seen: number[] = [];
    await drive(op, () => plainDoneAdapter(seen));

    // NON-VACUOUS: the veto really drove a second turn, and it really was the
    // CONTINUATION GUARD's — the gate chain is never entered once the guard
    // has set terminalReason=null, so late-inject cannot have fired.
    expect(seen).toEqual([0, 1]);
    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");
    expect(vi.mocked(runBuildVerifyGate)).not.toHaveBeenCalled();

    const reopens = firesFor(op.id).filter(f => f.outcome === "reopen");
    expect(reopens.map(f => `${f.name}/${f.reason}/${f.turnIdx}`))
      .toEqual(["continuation-guard/injects-pending/0"]);
    // Same seam as its sibling: banked after the turn it vetoes is durable.
    expect(reopens[0]!.seq).toBeGreaterThan(commitSeq(op.id, 0));
  }, 30_000);
});

// ── (c) the double-count guard ───────────────────────────────────────────

describe("reopen (c) — the guard's two SPEAKING branches bank no extra row", () => {
  it("a middleware nudge re-opens and files ONE row, its own `nudge`", async () => {
    const op = mkOp("mwnudge");
    trackOpForSession(op.id, `sess-${op.id}`);
    setMiddlewareStack([nudgeOnTurnMiddleware(0)]);

    const seen: number[] = [];
    await drive(op, () => plainDoneAdapter(seen));

    // NON-VACUOUS: the nudge really re-opened the turn.
    expect(seen).toEqual([0, 1]);
    const fires = firesFor(op.id);
    expect(fires.map(f => `${f.name}/${f.outcome}`)).toEqual(["ri-nudger/nudge"]);
    // The message IS the landed effect — a `reopen` beside it would count one
    // user-visible act twice.
    expect(fires.filter(f => f.outcome === "reopen")).toEqual([]);
  }, 30_000);

  it("the failure-summary nudge re-opens and files ONE row, its own `nudge`", async () => {
    // The rendered `[error]` header is what collectToolFailures actually reads
    // (result-helpers.ts parseStatusHeader) — a bare {error} object parses as
    // "ok" and the whole branch would never arm.
    setToolDispatcher(functionToolDispatcher(async () => ({
      status: "error" as const, result: "[error] ENOENT: no such file",
    })));
    const op = mkOp("failnudge");
    trackOpForSession(op.id, `sess-${op.id}`);
    setMiddlewareStack([]);

    const seen: number[] = [];
    await drive(op, () => failingCallAdapter(seen));

    // NON-VACUOUS: the failed call really re-opened the turn.
    expect(seen).toEqual([0, 1]);
    const fires = firesFor(op.id);
    expect(fires.map(f => `${f.name}/${f.outcome}`)).toEqual(["tool-failure-summary/nudge"]);
    expect(fires.filter(f => f.outcome === "reopen")).toEqual([]);
  }, 30_000);
});
