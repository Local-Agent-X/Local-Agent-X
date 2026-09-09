/**
 * E1 — the campaign's integration gate. ONE cross-seam contract over the four
 * systems the provenance / guard-counter campaign changed, exercised on REAL
 * ops driven through the REAL loop (canonicalLoopEntry → scheduler → worker →
 * turn-loop → real middleware host → real commitTurn → real canonical event
 * log). The only seams faked are the two the module deliberately exposes for
 * that purpose: the per-op adapter (registerAdapterForOp) and the tool
 * dispatcher (setToolDispatcher) — exactly as full-turn.test.ts does.
 *
 * Each chunk passed ALONE. This file proves they compose:
 *
 *   SEAM 1 — PROVENANCE. `op.taskProvenance === "harness"` survives writeOp,
 *            the worker's read-back and buildCanonicalLoopContext, and reaches
 *            the guard as `ctx.op.taskProvenance`.
 *   SEAM 2 — THE GATES. broad-sweep-nudge / cleanup-verify / codebase-advice
 *            return `continue` on a harness-stamped op whose task text WOULD
 *            trip every one of their predicates.
 *   SEAM 3 — THE COUNTER. `middleware_fired` is minted (guard-fire.ts) on the
 *            nudge path AND on the abort path, and is ABSENT when a guard
 *            stands down.
 *   SEAM 4 — THE REASON VOCABULARY. The `reason` the counter records is the
 *            same string the guard's owning module exports, and the consequence
 *            dispatch (retract-false-claim / decide-outcome) keys off that same
 *            string on that same op.
 *
 * SEAM 3 × SEAM 4 is the pairing that had never been exercised together: the
 * counter's body and the retraction of the assistant text are read off ONE live
 * op below, not asserted side by side in two unit tests.
 *
 * WHERE THIS FILE STARTS. The `harnessAuthoredTask` option → `taskProvenance`
 * translation inside runAgentViaCanonical (agent-runner/run.ts:140) is pinned by
 * run.task-provenance.test.ts against the REAL runner; reaching it here would
 * need a live provider credential and an adapter registration, so this file
 * picks the contract up one expression downstream — at the persisted op — and
 * mirrors that expression verbatim in `mkOp` so the two cannot drift silently.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  canonicalLoopEntry,
  registerAdapterForOp,
  setToolDispatcher,
  functionToolDispatcher,
  awaitCanonicalOp,
  awaitIdle,
  readCanonicalEvents,
  readOpMessages,
  resetCanonicalRuntime,
  resetScheduler,
} from "../src/canonical-loop/index.js";
import { setMiddlewareStack, _resetMiddlewareStack } from "../src/canonical-loop/middlewares/host.js";
import {
  broadSweepNudgeMiddleware,
  looksLikeBroadSweep,
} from "../src/canonical-loop/middlewares/broad-sweep-nudge.js";
import { cleanupVerifyMiddleware } from "../src/canonical-loop/middlewares/cleanup-verify.js";
import { codebaseAdviceMiddleware } from "../src/canonical-loop/middlewares/codebase-advice.js";
import { repeatOutputMiddleware } from "../src/canonical-loop/middlewares/repeat-output.js";
import { createInstructionLedgerMiddleware } from "../src/canonical-loop/middlewares/instruction-ledger.js";
import { isHarnessAuthoredTask } from "../src/canonical-loop/middlewares/types.js";
import { isRetractableHallucination } from "../src/canonical-loop/turn-loop/retract-false-claim.js";
import {
  CLEANUP_VERIFY_FALSE_DONE_REASON,
  CODEBASE_ADVICE_GROUNDING_REASON,
  CODEBASE_ADVICE_GROUNDING_STATUS,
  checkUngroundedCodebaseAdvice,
  looksLikeCleanupSweep,
} from "../src/agent-guards/index.js";
import { extractConstraints, phraseGate } from "../src/canonical-loop/instruction-ledger/extract.js";
import { buildSelfEditPrompt } from "../src/self-edit/prompt.js";
import { ToolBlocked, assertToolCallAllowed } from "../src/tool-execution/pre-dispatch.js";
import { newOpId } from "../src/ops/op-store.js";
import type { Op } from "../src/ops/types.js";
import type { CanonicalMiddleware } from "../src/canonical-loop/middlewares/types.js";
import type { Adapter, AdapterReport, TurnInput, TurnResult } from "../src/canonical-loop/adapter-contract.js";
import type { ToolCall } from "../src/canonical-loop/contract-types.js";
import type { CanonicalLoopContext } from "../src/canonical-loop/middlewares/types.js";
import type { MiddlewareFiredBody } from "../src/canonical-loop/types.js";

// The cleanup-verify LLM confirm is DISABLED, not stubbed: its documented
// contract is "YES / null / timeout / disabled (LAX_LLM_CLEANUP_VERIFY=0) →
// retract exactly as before", so the deterministic regex floor is what runs and
// no test here reaches a provider.
process.env.LAX_LLM_CLEANUP_VERIFY = "0";

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];

/**
 * ONE task text that trips ALL THREE gate predicates — every assertion below
 * depends on that, so it is PROVEN (not assumed) by the first describe block.
 *   broad-sweep    : scope cue "every" / "across the codebase" + action "find" / "remove"
 *   cleanup-sweep  : removal cue "remove" + breadth cue "every" / "reference"
 *   codebase-advice: subject "codebase" + advice request "what should we do next"
 */
const TRIPWIRE_TASK =
  "What should we do next: find and remove every leftover reference to the " +
  "legacy tailnet client across the codebase?";

/**
 * ONE wrap-up text that trips both text-side predicates:
 *   codebase-advice: implementation advice ("we should"), no freshness ack
 *   cleanup-verify : a positive done-claim with no negation → the RETRACT-grade
 *                    escalation, CLEANUP_VERIFY_FALSE_DONE_REASON
 */
const TRIPWIRE_WRAPUP =
  "We should drop the legacy tailnet client wholesale — all references are " +
  "gone now, so the cleanup is complete.";

/** A follow-up wrap-up that trips nothing, so a nudged op converges instead of
 *  spinning against the same guard forever. */
const BENIGN_WRAPUP = "Understood.";

// ── Op factory ───────────────────────────────────────────────────────────

/**
 * `taskProvenance: harnessAuthoredTask ? "harness" : undefined` is
 * agent-runner/run.ts:140 verbatim — the sole bridge between a harness caller
 * and the stamp the gates read. Copied rather than imported because run.ts
 * pulls in the provider-registry graph; run.task-provenance.test.ts pins the
 * real expression against the real runner in both directions.
 */
function mkOp(
  label: string,
  opts: { harnessAuthoredTask?: boolean; type?: string; task?: string } = {},
): Op {
  const id = newOpId(`e1_${label}_${randomUUID().slice(0, 6)}`);
  const task = opts.task ?? TRIPWIRE_TASK;
  tracked.push(id);
  return {
    id,
    type: opts.type ?? "freeform",
    task,
    taskProvenance: opts.harnessAuthoredTask ? "harness" : undefined,
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

const providerState = { adapterName: "e1-fake", adapterVersion: "1", providerPayload: null };

function finalize(report: (r: AdapterReport) => void, id: string, text: string, calls?: ToolCall[]): void {
  report({
    kind: "message_finalized",
    message: { messageId: id, role: "assistant", content: calls ? { text, toolCalls: calls } : { text } },
  });
}

/** Turn 0 emits the tripwire wrap-up; every later turn emits a benign one. */
function wrapUpAdapter(seenTurns: number[] = []): Adapter {
  return {
    name: "e1-wrapup",
    version: "1",
    async runTurn(input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult> {
      seenTurns.push(input.turnIdx);
      finalize(report, `e1-am-${input.turnIdx}`, input.turnIdx === 0 ? TRIPWIRE_WRAPUP : BENIGN_WRAPUP);
      return { providerState, terminalReason: "done", modelStop: "ended" };
    },
    async abort(): Promise<void> { /* scripted turns unwind immediately */ },
  };
}

/**
 * Turn 0 tripwire wrap-up; turn 1 a real `grep` that comes back empty (the
 * search-clean evidence cleanup-verify grounds on); turn 2+ a benign wrap-up.
 * Used for the cleanup op so its bounded 3-nudge retry converges after ONE fire.
 */
function grepThenWrapUpAdapter(seenTurns: number[] = []): Adapter {
  return {
    name: "e1-grep",
    version: "1",
    async runTurn(input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult> {
      seenTurns.push(input.turnIdx);
      if (input.turnIdx === 1) {
        const call: ToolCall = { toolCallId: "e1-grep-1", tool: "grep", args: { pattern: "tailnet" } };
        report({ kind: "tool_call_requested", call });
        finalize(report, "e1-am-grep", "Re-running the search.", [call]);
        return { providerState, modelStop: "continue" };
      }
      finalize(report, `e1-am-${input.turnIdx}`, input.turnIdx === 0 ? TRIPWIRE_WRAPUP : BENIGN_WRAPUP);
      return { providerState, terminalReason: "done", modelStop: "ended" };
    },
    async abort(): Promise<void> { /* scripted turns unwind immediately */ },
  };
}

/** The same substantive answer every turn, alongside a non-silent tool call so
 *  the turn never self-terminates — the real shape repeat-output breaks on. */
function stuckLoopAdapter(seenTurns: number[] = []): Adapter {
  return {
    name: "e1-stuck",
    version: "1",
    async runTurn(input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult> {
      seenTurns.push(input.turnIdx);
      const call: ToolCall = { toolCallId: `e1-read-${input.turnIdx}`, tool: "read", args: { path: "a.ts" } };
      report({ kind: "tool_call_requested", call });
      finalize(
        report,
        `e1-am-${input.turnIdx}`,
        "I am reading the tailnet client module again to work out which references still matter.",
        [call],
      );
      return { providerState, modelStop: "continue" };
    },
    async abort(): Promise<void> { /* scripted turns unwind immediately */ },
  };
}

// ── Drive + read helpers ─────────────────────────────────────────────────

interface FiredEvent extends MiddlewareFiredBody { seq: number }

/** Every `middleware_fired` on the op's DURABLE canonical event log. */
function firesFor(opId: string): FiredEvent[] {
  return readCanonicalEvents(opId)
    .filter(e => e.type === "middleware_fired")
    .map(e => ({ seq: e.seq, ...(e.body as unknown as MiddlewareFiredBody) }));
}

function nudgeRows(opId: string): string[] {
  return readOpMessages(opId)
    .filter(r => r.role === "user" && (r.content as { kind?: string }).kind === "nudge")
    .map(r => (r.content as { text: string }).text);
}

function assistantTexts(opId: string): string[] {
  return readOpMessages(opId)
    .filter(r => r.role === "assistant")
    .map(r => (r.content as { text?: string }).text ?? "");
}

async function drive(op: Op, adapter: () => Adapter): Promise<void> {
  registerAdapterForOp(op.id, adapter);
  canonicalLoopEntry(op);
  const result = await awaitCanonicalOp(op.id, 10_000);
  expect(result, `op ${op.id} never reached a terminal state`).not.toBeNull();
  await awaitIdle(5_000);
  // Never assert against an op that did not actually run a turn.
  expect(
    readCanonicalEvents(op.id).some(e => e.type === "turn_committed"),
    `op ${op.id} committed no turn — the assertions below would pass vacuously`,
  ).toBe(true);
}

beforeEach(() => {
  setToolDispatcher(functionToolDispatcher(async (call: ToolCall) => (
    call.tool === "grep"
      ? { status: "ok" as const, result: "No matches found." }
      : { status: "ok" as const, result: { ok: true } }
  )));
});

afterEach(async () => {
  await awaitIdle(3_000).catch(() => undefined);
  _resetMiddlewareStack();
});

afterAll(() => {
  resetScheduler();
  resetCanonicalRuntime();
  delete process.env.LAX_LLM_CLEANUP_VERIFY;
  for (const id of tracked) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});

// ── Non-vacuity: the fixture really does trip all three predicates ───────

describe("E1 fixture — one task text every gate predicate accepts", () => {
  it("trips broad-sweep, cleanup-sweep and codebase-advice on the SAME words", () => {
    expect(looksLikeBroadSweep(TRIPWIRE_TASK)).toBe(true);
    expect(looksLikeCleanupSweep(TRIPWIRE_TASK)).toBe(true);
    expect(checkUngroundedCodebaseAdvice(TRIPWIRE_TASK, TRIPWIRE_WRAPUP, new Set())).not.toBeNull();
  });

  it("the benign follow-up wrap-up trips none of them (so a nudged op converges)", () => {
    expect(checkUngroundedCodebaseAdvice(TRIPWIRE_TASK, BENIGN_WRAPUP, new Set())).toBeNull();
  });
});

// ── (a) + (b): provenance ↔ gates ↔ counter, one live op per guard ───────

const GATES = [
  {
    name: "broad-sweep-nudge",
    mw: broadSweepNudgeMiddleware,
    reason: "broad-sweep-enumerate",
    adapter: wrapUpAdapter,
  },
  {
    name: "cleanup-verify",
    mw: cleanupVerifyMiddleware,
    reason: CLEANUP_VERIFY_FALSE_DONE_REASON,
    adapter: grepThenWrapUpAdapter,
  },
  {
    name: "codebase-advice",
    mw: codebaseAdviceMiddleware,
    reason: CODEBASE_ADVICE_GROUNDING_REASON,
    adapter: wrapUpAdapter,
  },
] as const;

describe("E1 (a) — a HARNESS-authored op is not nudged, and mints no fire", () => {
  it.each(GATES)("$name stands down on op.taskProvenance='harness'", async ({ name, mw, adapter }) => {
    setMiddlewareStack([mw]);
    const turns: number[] = [];
    const op = mkOp(`harness_${name.replace(/-/g, "")}`, { harnessAuthoredTask: true });
    await drive(op, () => adapter(turns));

    expect(turns).toContain(0);
    // SEAM 2: no nudge row. SEAM 3: and no fire counted for it either — the
    // stand-down is invisible to the counter, which is the correct reading of
    // "a guard that looked and let the turn pass".
    expect(nudgeRows(op.id)).toEqual([]);
    expect(firesFor(op.id).filter(f => f.name === name)).toEqual([]);
  });
});

describe("E1 (b) — the SAME words on a USER-authored op nudge, and the counter agrees with the vocabulary", () => {
  it.each(GATES)("$name fires and records reason=$reason", async ({ name, mw, reason, adapter }) => {
    setMiddlewareStack([mw]);
    const turns: number[] = [];
    const op = mkOp(`user_${name.replace(/-/g, "")}`);
    await drive(op, () => adapter(turns));

    // SEAM 2: it nudged.
    expect(nudgeRows(op.id).length).toBeGreaterThanOrEqual(1);
    // SEAM 3 × SEAM 4: exactly one fire for this guard, named by the guard and
    // carrying the reason string the guard's OWN module exports.
    const fires = firesFor(op.id).filter(f => f.name === name);
    expect(fires).toHaveLength(1);
    expect(fires[0].reason).toBe(reason);
    // A nudge's fire files under the turn the nudge LANDS on (turnIdx + 1).
    expect(fires[0].turnIdx).toBe(1);
  });

  it("cleanup-verify: the counted reason is the one the RETRACT dispatch acts on, on the same op", async () => {
    setMiddlewareStack([cleanupVerifyMiddleware]);
    const op = mkOp("user_retract");
    await drive(op, () => grepThenWrapUpAdapter());

    const fire = firesFor(op.id).find(f => f.name === "cleanup-verify");
    expect(fire?.reason).toBe(CLEANUP_VERIFY_FALSE_DONE_REASON);
    // SEAM 4: the vocabulary classifies that exact string as retractable...
    expect(isRetractableHallucination(fire!.reason)).toBe(true);
    // ...and the loop actually retracted it — the confirmed-false done-claim is
    // NOT in the committed transcript, while the later honest turn is.
    const texts = assistantTexts(op.id);
    expect(texts).not.toContain(TRIPWIRE_WRAPUP);
    expect(texts).toContain(BENIGN_WRAPUP);
  });

  it("codebase-advice: the counted reason is the one the REPLACE-STATUS dispatch acts on", async () => {
    setMiddlewareStack([codebaseAdviceMiddleware]);
    const op = mkOp("user_replace_status");
    await drive(op, () => wrapUpAdapter());

    const fire = firesFor(op.id).find(f => f.name === "codebase-advice");
    expect(fire?.reason).toBe(CODEBASE_ADVICE_GROUNDING_REASON);
    // replace-status, NOT retract — the text is swapped, never dropped.
    expect(isRetractableHallucination(fire!.reason)).toBe(false);
    const texts = assistantTexts(op.id);
    expect(texts).not.toContain(TRIPWIRE_WRAPUP);
    expect(texts).toContain(CODEBASE_ADVICE_GROUNDING_STATUS);
  });
});

// ── (c): the abort tier is counted — nudge AND abort in ONE op ───────────

describe("E1 (c) — a guard that ABORTS is counted, once, beside its own earlier nudge", () => {
  it("repeat-output records a nudge fire AND an abort fire on the same op", async () => {
    setMiddlewareStack([repeatOutputMiddleware]);
    const turns: number[] = [];
    const op = mkOp("abort_tier");
    await drive(op, () => stuckLoopAdapter(turns));

    const fires = firesFor(op.id).filter(f => f.name === "repeat-output");
    // Two fires, not one and not three: the nudge tier (fired on turn 2, filed
    // under the turn it lands on) and the abort tier (filed under the turn it
    // stopped) are counted separately, and neither is double-counted.
    expect(fires.map(f => f.turnIdx)).toEqual([3, 4]);
    expect(new Set(fires.map(f => f.reason))).toEqual(new Set(["repeat-output"]));
    // The abort really ended the op — the fire is not counted for a verdict
    // that never took effect (recordGuardFire is gated on emitErrorOnce).
    const errors = readCanonicalEvents(op.id).filter(e => e.type === "error");
    expect(errors.filter(e => (e.body as { code?: string }).code === "middleware-abort")).toHaveLength(1);
    // Exactly one nudge row: the abort speaks through the error bubble, not a
    // second op_message.
    expect(nudgeRows(op.id)).toHaveLength(1);
  }, 20_000);
});

// ── KNOWN INTERACTION: provenance vs the ledger-emptying re-eligibility ──

/** The workspace-write ban a real user phrasing would produce, injected through
 *  the instruction-ledger middleware's documented factory seam. */
const banWorkspaceWrite = async () => ({
  prohibitions: ["workspace-write" as const],
  obligations: [],
  phrases: ["don't change any files"],
});
const banNothing = async () => ({ prohibitions: [], obligations: [], phrases: [] });

describe("E1 known interaction — emptying the ledger re-opens the nudge; provenance still wins", () => {
  it("USER op + workspace-write ban ⇒ suppressed by the LEDGER gate (the baseline)", async () => {
    setMiddlewareStack([createInstructionLedgerMiddleware(banWorkspaceWrite), broadSweepNudgeMiddleware]);
    const op = mkOp("ledger_ban");
    await drive(op, () => wrapUpAdapter());
    expect(nudgeRows(op.id)).toEqual([]);
    expect(firesFor(op.id)).toEqual([]);
  });

  it("USER op + EMPTY ledger ⇒ eligible, and it nudges (proving the ban is what suppressed it)", async () => {
    setMiddlewareStack([createInstructionLedgerMiddleware(banNothing), broadSweepNudgeMiddleware]);
    const op = mkOp("ledger_free");
    await drive(op, () => wrapUpAdapter());
    expect(nudgeRows(op.id)).toHaveLength(1);
    expect(firesFor(op.id).map(f => f.reason)).toEqual(["broad-sweep-enumerate"]);
  });

  it("HARNESS op ⇒ the ledger is emptied (newly eligible) yet the provenance gate still stands it down", async () => {
    // The extractor WOULD ban workspace-write, but instruction-ledger never
    // calls it for a harness-authored op — it records the EMPTY ledger. That is
    // exactly the re-eligibility this test exists for: the ledger gate at
    // broad-sweep-nudge.ts:62 can no longer suppress anything, so the ONLY thing
    // between this op and a nudge is the provenance gate above it at :47.
    let extractorCalls = 0;
    const extract = async () => { extractorCalls++; return banWorkspaceWrite(); };
    setMiddlewareStack([createInstructionLedgerMiddleware(extract), broadSweepNudgeMiddleware]);
    const op = mkOp("ledger_harness", { harnessAuthoredTask: true });
    await drive(op, () => wrapUpAdapter());
    expect(extractorCalls, "instruction-ledger must skip extraction for a harness op").toBe(0);
    expect(nudgeRows(op.id)).toEqual([]);
    expect(firesFor(op.id)).toEqual([]);
  });
});

// ── DELIBERATE DIVERGENCE: the gates and the ledger read different predicates ──

describe("E1 divergence — app_build: the ledger calls it harness-authored, the gates do not", () => {
  it("the two predicates disagree by construction on an unstamped app_build op", () => {
    const ctx = { op: { id: "x", type: "app_build" } } as unknown as CanonicalLoopContext;
    expect(isHarnessAuthoredTask(ctx)).toBe(true);
    expect(ctx.op.taskProvenance).toBeUndefined();
  });

  it("and the divergence is REAL end to end: an app_build op still gets the sweep nudge", async () => {
    // Deliberate and documented (broad-sweep-nudge.ts:47-54): op.type is
    // MODEL-supplied and unvalidated, so keying the gate on it would let a model
    // mute the guard on a real user request. The cost is exactly this: an
    // app_build op whose task text reads as a sweep is NOT gated. Real
    // build-app.ts ops carry task `Build app "<name>"`, which trips no
    // predicate — pinned first, so the argument stops holding out loud if that
    // task text ever changes.
    expect(looksLikeBroadSweep('Build app "notes"')).toBe(false);
    expect(looksLikeCleanupSweep('Build app "notes"')).toBe(false);

    setMiddlewareStack([broadSweepNudgeMiddleware]);
    const op = mkOp("appbuild_divergence", { type: "app_build" });
    await drive(op, () => wrapUpAdapter());
    expect(firesFor(op.id).map(f => f.reason)).toEqual(["broad-sweep-enumerate"]);
  });
});

// ── THE HEADLINE FIX, end to end: the self_edit surgeon reaches its own tools ──

/**
 * A probe middleware that runs the REAL pre-dispatch gate at the exact moment
 * the surgeon's first tool call would, on the REAL per-op ledger the
 * instruction-ledger middleware just recorded. It has to run in-loop: the
 * ledger is dropped on op terminal (state-machine's clearOpLedger), so nothing
 * observable survives the run.
 *
 * WHAT THIS COVERS AND WHAT IT DOES NOT. It calls assertToolCallAllowed with
 * no security layer / tool policy / threat engine and skipSessionPolicy — the
 * packs tolerate that (pre-dispatch.test.ts uses the same ctx), so the op
 * instruction-ledger gate is the ONLY gate that can throw, and an allow/deny
 * difference between the two runs below is attributable to the ledger alone.
 * It does NOT drive the surgeon's real tool dispatcher, and it does not run the
 * ledger's LLM confirm (see `offlineExtract`) — no test here reaches a provider.
 */
function preDispatchProbe(
  calls: ReadonlyArray<{ name: string; args: Record<string, unknown> }>,
  sink: Map<string, string | null>,
): CanonicalMiddleware {
  return {
    name: "e1-pre-dispatch-probe",
    async beforeTurn(ctx) {
      for (const c of calls) {
        try {
          await assertToolCallAllowed(
            { id: `probe-${c.name}`, name: c.name, args: c.args },
            { sessionId: "e1-selfedit", callContext: "delegated", skipSessionPolicy: true, opId: ctx.op.id },
          );
          sink.set(c.name, null);
        } catch (e) {
          sink.set(c.name, e instanceof ToolBlocked ? e.reason : `unexpected: ${(e as Error).message}`);
        }
      }
      return { kind: "continue" };
    },
  };
}

/** The REAL extractor with its LLM confirm stubbed to null — the genuine
 *  phrase-gate + deterministic strong tier, which is what actually bricked the
 *  surgeon (the ban survived an LLM outage). Mirrors instruction-ledger.test.ts. */
const offlineExtract = (msg: string) => extractConstraints(msg, async () => null);

const SURGEON_TOOL_CALLS = [
  { name: "write", args: { path: "src/x.ts", content: "x" } },
  { name: "edit", args: { path: "src/x.ts", old_string: "a", new_string: "b" } },
  { name: "bash", args: { command: "sed -i 's/a/b/' src/x.ts" } },
] as const;

describe("E1 headline fix — the self_edit surgeon is no longer denied by the rules file it quotes", () => {
  it("the hazard is real: the surgeon's own prompt strong-extracts a workspace-write ban", async () => {
    const gate = phraseGate(await buildSelfEditPrompt("fix the wedge in the scheduler", ""));
    expect(gate.strong.prohibitions).toContain("workspace-write");
  });

  it("BEFORE (unstamped): the ledger records the ban and pre-dispatch hard-denies write/edit/bash", async () => {
    const seen = new Map<string, string | null>();
    setMiddlewareStack([
      createInstructionLedgerMiddleware(offlineExtract),
      preDispatchProbe(SURGEON_TOOL_CALLS, seen),
    ]);
    const op = mkOp("selfedit_before", {
      type: "self_edit",
      task: await buildSelfEditPrompt("fix the wedge in the scheduler", ""),
    });
    await drive(op, () => wrapUpAdapter());

    expect(seen.get("write")).toContain("The user asked you not to edit or write files");
    expect(seen.get("edit")).toContain("The user asked you not to edit or write files");
    expect(seen.get("bash")).toContain("writes to the filesystem");
  });

  it("AFTER (harness-stamped): the ledger stays empty and all three tools dispatch", async () => {
    const seen = new Map<string, string | null>();
    setMiddlewareStack([
      createInstructionLedgerMiddleware(offlineExtract),
      preDispatchProbe(SURGEON_TOOL_CALLS, seen),
    ]);
    const op = mkOp("selfedit_after", {
      type: "self_edit",
      harnessAuthoredTask: true,
      task: await buildSelfEditPrompt("fix the wedge in the scheduler", ""),
    });
    await drive(op, () => wrapUpAdapter());

    expect([...seen.entries()]).toEqual([["write", null], ["edit", null], ["bash", null]]);
  });
});
