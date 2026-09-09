/**
 * E2 — the campaign's closing integration gate. ONE cross-seam contract over
 * the pieces the guard-outcome campaign changed, exercised on REAL ops driven
 * through the REAL loop (canonicalLoopEntry → scheduler → worker → turn-loop →
 * real middleware host → real completion-gate chain → real commitTurn → real
 * canonical event log on disk). It is the sibling of
 * test/provenance-gates-counter.contract.test.ts, and it takes the same live
 * substrate full-turn.test.ts established.
 *
 * Each chunk passed ALONE, and each was pinned by unit tests that call one gate
 * or one epilogue directly. This file proves they COMPOSE:
 *
 *   SEAM 1 — THE DISCRIMINATOR. `outcome` and its closed 8-value vocabulary
 *            (types.ts GuardOutcome, guard-fire.ts) reach canonical-events.jsonl
 *            with the right value for each shape, on ops the loop really ran.
 *            The pair that justifies the field — one gate's retry nudge and the
 *            terminal it later authored, identical in name / reason / turnIdx —
 *            is read off ONE live op here, not asserted in two unit tests.
 *   SEAM 2 — THE EARNED-FIRE SEAM. A gate NAMES a fire beside its payload,
 *            the code that performs the effect MINTS it, and turn-loop.ts BANKS
 *            it after commitTurn and past the cancel bail. All three halves are
 *            visible in the persisted log: a nudge fire lands BEFORE its turn's
 *            `turn_committed`, the terminal fire lands AFTER it, and a Stop in
 *            the gate window lands neither.
 *   SEAM 3 — THE SPLIT GATE TABLE. decide-outcome-gates.ts (the order + the
 *            "is this turn over?" gates), decide-outcome-verify-gates.ts (the
 *            five external checks) and decide-outcome-gate-contract.ts (the
 *            shared surface) still form ONE table, and the chain the loop walks
 *            contains the very objects those modules export.
 *   SEAM 4 — THE BUILD GATE (078a823c). Raw control bytes / bidi overrides and
 *            the 400-LOC ceiling are a build failure, and the merged campaign —
 *            every file all four chunks touched, including the two the split
 *            created — still clears both.
 *
 * SEAM 1 × SEAM 2 is the pairing no chunk could test: the epilogue's
 * `!endedPartial` decision (chunk 4) and the post-commit bank (chunk 2) are one
 * mechanism only when a real op runs through both, and `honest-terminal`'s two
 * producers are only separable if both reach the same log under different
 * `name`s — proven below on two ops, not by reading the ledger.
 *
 * WHAT IS FAKED, AND WHY ONLY THIS. The two seams canonical-loop exposes for
 * exactly this purpose — the per-op adapter (registerAdapterForOp) and the tool
 * dispatcher (setToolDispatcher) — plus the three completion gates whose work is
 * an EXTERNAL process: build-verify spawns the project's own build, spec-probe
 * and spec-audit each make a provider call. Their gate OBJECTS, their entry
 * conditions, the chain runner, decide-outcome, the epilogue, the fire seam and
 * the event log are all real; only the outside-world verdict is scripted, the
 * same way nudges.middleware-fired.test.ts scripts render-verify's probe. No
 * unit under test is mocked.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ── Scripted EXTERNAL checks (see "WHAT IS FAKED" above) ─────────────────
// Partial mocks: terminal-epilogue.ts imports groundTruthSizesNote from
// build-verify.js and must keep the real one, and nothing else in these
// modules is steered.
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
  readOpMessages,
  resetCanonicalRuntime,
  resetScheduler,
} from "../src/canonical-loop/index.js";
import { CANONICAL_EVENTS_FILE } from "../src/canonical-loop/schema.js";
import { setMiddlewareStack, _resetMiddlewareStack } from "../src/canonical-loop/middlewares/host.js";
import { verifyGateMiddleware } from "../src/canonical-loop/middlewares/verify-gate.js";
import {
  COMPLETION_GATES,
  COMPLETION_GATE_ORDER,
} from "../src/canonical-loop/turn-loop/decide-outcome-gates.js";
import {
  buildVerifyGate,
  designVerifyGate,
  renderVerifyGate,
  specAuditGate,
  specProbeGate,
} from "../src/canonical-loop/turn-loop/decide-outcome-verify-gates.js";
import { CONTINUE, gateSource } from "../src/canonical-loop/turn-loop/decide-outcome-gate-contract.js";
import { runBuildVerifyGate } from "../src/canonical-loop/turn-loop/build-verify.js";
import { trackOpForSession } from "../src/ops/session-bridge.js";
import { taskTools } from "../src/tools/task-tools.js";
import { newOpId } from "../src/ops/op-store.js";
import { readOp } from "../src/ops/op-store.js";
import { exoticCodePointErrors } from "../scripts/check-source-hygiene.mjs";
import type { Op } from "../src/ops/types.js";
import type { Adapter, AdapterReport, TurnInput, TurnResult } from "../src/canonical-loop/adapter-contract.js";
import type { ToolCall } from "../src/canonical-loop/contract-types.js";
import type { CanonicalMiddleware } from "../src/canonical-loop/middlewares/types.js";
import type { CanonicalEvent, GuardOutcome, MiddlewareFiredBody } from "../src/canonical-loop/types.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];

/**
 * The muse-glimmer leak, verbatim in shape: a final assistant text that still
 * carries recognized tool-call SYNTAX, so the call never ran. The namespace
 * prefix is deliberately NOT the real one — tool-call-text-syntaxes.ts accepts
 * any prefix, and writing the live marker into a test file would make the file
 * itself look like a leaked call to every scanner in the repo.
 */
const LEAKED_TEXT =
  "Let me search for that.\n" +
  '<atem:function_calls><atem:invoke name="grep"><atem:parameter name="pattern">tailnet</atem:parameter>' +
  "</atem:invoke></atem:function_calls>";

/** build-verify's held green line — the confirmation the epilogue decides on. */
const CONFIRMATION = "✓ Verified: the harness ran `npm run build` and it passed with no errors.";

/** A source edit, so build-verify's entry condition (opEditedSourceUnverified)
 *  is satisfied by the REAL verify-gate middleware watching a REAL dispatch. */
const SOURCE_WRITE: ToolCall = {
  toolCallId: "e2-write-1",
  tool: "write",
  args: { path: "src/e2-probe.ts", content: "export const a = 1;\n" },
};
const TASK_CALL: ToolCall = {
  toolCallId: "e2-task-1",
  tool: "task_create",
  args: { description: "Finish the migration" },
};

// ── Op factory ───────────────────────────────────────────────────────────

function mkOp(label: string): Op {
  const id = newOpId(`e2_${label}_${randomUUID().slice(0, 6)}`);
  const task = "Do the thing.";
  tracked.push(id);
  return {
    id,
    type: "freeform",
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

const providerState = { adapterName: "e2-fake", adapterVersion: "1", providerPayload: null };

function finalize(report: (r: AdapterReport) => void, id: string, text: string, calls?: ToolCall[]): void {
  report({
    kind: "message_finalized",
    message: { messageId: id, role: "assistant", content: calls ? { text, toolCalls: calls } : { text } },
  });
}

/** Leaks tool-call syntax as its final text on EVERY turn: turn 0 earns the
 *  gate's one retry nudge, turn 1 the honest terminal. */
function leakingAdapter(seen: number[] = []): Adapter {
  return {
    name: "e2-leak",
    version: "1",
    async runTurn(input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult> {
      seen.push(input.turnIdx);
      finalize(report, `e2-am-${input.turnIdx}`, LEAKED_TEXT);
      return { providerState, terminalReason: "done", modelStop: "ended" };
    },
    async abort(): Promise<void> { /* scripted turns unwind immediately */ },
  };
}

/**
 * Edits source and finishes in ONE turn. The write rides the SAME turn as the
 * final text on purpose: verify-gate's own wrap-up nudge is skipped on a turn
 * that carries tool calls, so the op reaches its terminal without a middleware
 * nudge re-opening it — the edit is real, and so is the terminal.
 */
function editingAdapter(): Adapter {
  return {
    name: "e2-edit",
    version: "1",
    async runTurn(input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult> {
      report({ kind: "tool_call_requested", call: SOURCE_WRITE });
      finalize(report, `e2-am-edit-${input.turnIdx}`, "Wrote the module. All set.", [SOURCE_WRITE]);
      return { providerState, terminalReason: "done", modelStop: "ended" };
    },
    async abort(): Promise<void> { /* scripted turns unwind immediately */ },
  };
}

/**
 * Turn 0 works the task ledger (so the loud-partial warning is allowed to name
 * this op), turn 1 edits source and finishes — the same terminal as
 * editingAdapter, but on an op that ends with an open step.
 */
function ledgerThenEditAdapter(): Adapter {
  return {
    name: "e2-ledger-edit",
    version: "1",
    async runTurn(input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult> {
      if (input.turnIdx === 0) {
        report({ kind: "tool_call_requested", call: TASK_CALL });
        finalize(report, "e2-am-task", "", [TASK_CALL]);
        return { providerState, modelStop: "continue" };
      }
      report({ kind: "tool_call_requested", call: SOURCE_WRITE });
      finalize(report, `e2-am-edit-${input.turnIdx}`, "Wrote the module. All set.", [SOURCE_WRITE]);
      return { providerState, terminalReason: "done", modelStop: "ended" };
    },
    async abort(): Promise<void> { /* scripted turns unwind immediately */ },
  };
}

/** A Stop that lands in the window driveTurn's cancel bail exists for: after
 *  the model returned, before decideTurnOutcome's gate chain and its commit. */
function stopOnTurnMiddleware(turnIdx: number): CanonicalMiddleware {
  return {
    name: "e2-stop",
    afterToolExecution(ctx) {
      if (ctx.turnIdx === turnIdx) opCancel(ctx.op.id, "e2-user-stop");
      return { kind: "continue" };
    },
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

/** The same rows, re-read straight off canonical-events.jsonl — the file the
 *  ledger in guard-fire.ts is written to be queried against. */
function firesOffDisk(opId: string): MiddlewareFiredBody[] {
  const path = join(OPS_BASE, opId, CANONICAL_EVENTS_FILE);
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l) as CanonicalEvent)
    .filter(e => e.type === "middleware_fired")
    .map(e => e.body as unknown as MiddlewareFiredBody);
}

/** `seq` of the `turn_committed` event for one turn (-1 when the turn never
 *  committed) — the durability line the earned-fire seam is defined against. */
function commitSeq(opId: string, turnIdx: number): number {
  const row = readCanonicalEvents(opId)
    .find(e => e.type === "turn_committed" && (e.body as { turnIdx?: number })?.turnIdx === turnIdx);
  return row?.seq ?? -1;
}

function messageIdKinds(opId: string): string[] {
  return readOpMessages(opId).map(r => r.messageId.split("-").slice(0, 3).join("-"));
}

async function drive(op: Op, adapter: () => Adapter): Promise<void> {
  registerAdapterForOp(op.id, adapter);
  canonicalLoopEntry(op);
  const result = await awaitCanonicalOp(op.id, 10_000);
  expect(result, `op ${op.id} never reached a terminal state`).not.toBeNull();
  await awaitIdle(5_000);
}

async function waitForState(opId: string, state: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (readOp(opId)?.canonical?.state === state) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`op ${opId} never reached ${state}; current=${readOp(opId)?.canonical?.state}`);
}

beforeEach(() => {
  setToolDispatcher(functionToolDispatcher(async () => ({ status: "ok" as const, result: { ok: true } })));
  vi.mocked(runBuildVerifyGate).mockResolvedValue({
    nudge: "", shouldRetry: false, capReached: false, verifiedClean: false, confirmation: "",
  });
});

afterEach(async () => {
  await awaitIdle(3_000).catch(() => undefined);
  _resetMiddlewareStack();
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

// ── (a) a settled-done op ────────────────────────────────────────────────

describe("E2 (a) — a settled-done op banks the gate's terminal on the real event log", () => {
  it("files the retry nudge and the terminal it later authored under ONE name, separated only by `outcome`", async () => {
    setMiddlewareStack([]);
    const op = mkOp("settled");
    const seen: number[] = [];
    await drive(op, () => leakingAdapter(seen));

    // Non-vacuity: the op really ran the two turns the gate's contract needs
    // (first fire → retry nudge, later fire → honest terminal) and ended done.
    expect(seen).toEqual([0, 1]);
    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");

    // SEAM 1. Both rows agree on name, reason AND turnIdx — `outcome` is the
    // only thing that tells the retry apart from the terminal. That claim was
    // the field's whole justification and this is the first time it is read off
    // a live op instead of two direct gate calls.
    const fires = firesFor(op.id);
    expect(fires.map(f => `${f.name}/${f.reason}/${f.turnIdx}/${f.outcome}`)).toEqual([
      "unresolved-tool-intent/unresolved-tool-intent/1/nudge",
      "unresolved-tool-intent/unresolved-tool-intent/1/honest-terminal",
    ]);
    // ...and it is the REAL canonical-events.jsonl, not the reader's view.
    expect(firesOffDisk(op.id).map(b => b.outcome)).toEqual(["nudge", "honest-terminal"]);

    // SEAM 2, both halves, visible in ONE log. The gate's nudge is banked where
    // it is written (before its turn commits, because op_messages already holds
    // it); the terminal is banked by turn-loop AFTER commitTurn, because until
    // then the message it describes exists only in memory.
    const nudgeFire = fires.find(f => f.outcome === "nudge")!;
    const terminalFire = fires.find(f => f.outcome === "honest-terminal")!;
    expect(nudgeFire.seq).toBeLessThan(commitSeq(op.id, 0));
    expect(terminalFire.seq).toBeGreaterThan(commitSeq(op.id, 1));

    // The terminal the fire claims is really in the transcript, authored by the
    // gate — a fire is a claim about a message, so the message is asserted too.
    const terminal = readOpMessages(op.id).find(r => r.messageId.startsWith("gate-terminal-"));
    expect(terminal).toBeDefined();
    expect((terminal!.content as { text: string }).text).toContain("Nothing was executed");
  }, 20_000);

  it("every outcome the loop persisted is in the closed vocabulary", async () => {
    setMiddlewareStack([]);
    const op = mkOp("vocab");
    await drive(op, () => leakingAdapter());
    // The census is a compile-time exhaustiveness check in
    // nudges.middleware-fired.test.ts; this is the runtime half — a row filed
    // under a value outside the union is a miscount no type can catch.
    const vocabulary: Record<GuardOutcome, true> = {
      nudge: true, abort: true, suspend: true, rewrite: true,
      "honest-terminal": true, reopen: true, repair: true, "gave-up": true,
    };
    const outcomes = firesFor(op.id).map(f => f.outcome);
    expect(outcomes.length).toBeGreaterThan(0);
    for (const o of outcomes) expect(Object.keys(vocabulary)).toContain(o);
  }, 20_000);
});

// ── (b) a Stop in the gate window ────────────────────────────────────────

describe("E2 (b) — a Stop in the completion-gate window banks NOTHING", () => {
  it("commits no terminal and records no fire for the terminal the gate had already named", async () => {
    // The Stop lands on turn 1, after the model returned and before
    // decideTurnOutcome — the window turn-loop.ts's cancel bail names, and the
    // window the whole earned-fire deferral exists for.
    setMiddlewareStack([stopOnTurnMiddleware(1)]);
    const op = mkOp("stopped");
    const seen: number[] = [];
    registerAdapterForOp(op.id, () => leakingAdapter(seen));
    canonicalLoopEntry(op);
    await waitForState(op.id, "cancelled");
    await awaitIdle(5_000);

    const fires = firesFor(op.id);
    // NON-VACUOUS, three ways. Turn 1 really ran, so the gate reached its
    // SECOND fire — the one that names an honest terminal, not a nudge.
    expect(seen).toEqual([0, 1]);
    // Turn 0 really committed, so the Stop landed on turn 1's gate window and
    // not before the op ever got going.
    expect(commitSeq(op.id, 0)).toBeGreaterThan(-1);
    // And turn 0's gate nudge IS on the log, so the chain really ran.
    expect(fires.map(f => f.outcome)).toEqual(["nudge"]);
    // Turn 1 never committed, so the terminal never existed...
    expect(commitSeq(op.id, 1)).toBe(-1);
    // ...and nothing claimed it did, in either direction: no fire, no message.
    expect(fires.some(f => f.outcome === "honest-terminal")).toBe(false);
    expect(messageIdKinds(op.id)).not.toContain("gate-terminal");
  }, 20_000);
});

// ── (c) the epilogue's suppression decides the second producer's fire ────

describe("E2 (c) — build-verify's confirmation is banked only where the user is shown it", () => {
  /** Both ops below need the SAME green verdict from the external build. */
  function scriptCleanBuild(): void {
    vi.mocked(runBuildVerifyGate).mockResolvedValue({
      nudge: "", shouldRetry: false, capReached: false, verifiedClean: true, confirmation: CONFIRMATION,
    });
  }

  it("a CLEAN-ending op appends the green line and banks `honest-terminal` under build-verify", async () => {
    setMiddlewareStack([verifyGateMiddleware]);
    scriptCleanBuild();
    const op = mkOp("clean");
    trackOpForSession(op.id, `sess-${op.id}`);
    await drive(op, editingAdapter);

    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");
    // The gate's entry condition was met by the REAL verify-gate middleware
    // watching a REAL dispatched write — the external build is the only script.
    expect(vi.mocked(runBuildVerifyGate)).toHaveBeenCalled();
    // The user really is shown the green line...
    expect(messageIdKinds(op.id)).toContain("build-verify-ok");
    // ...so the fire is earned, banked post-commit, under the SECOND producer's
    // own name.
    const fires = firesFor(op.id);
    expect(fires.map(f => `${f.name}/${f.outcome}`)).toEqual(["build-verify/honest-terminal"]);
    expect(fires[0]!.seq).toBeGreaterThan(commitSeq(op.id, 0));
  }, 20_000);

  it("a PARTIAL-ending op suppresses the green line, so it banks nothing", async () => {
    setMiddlewareStack([verifyGateMiddleware]);
    scriptCleanBuild();
    const op = mkOp("partial");
    const sessionId = `sess-${op.id}`;
    trackOpForSession(op.id, sessionId);
    // A REAL open step in the REAL task ledger, scoped to this op's session —
    // the loud-partial warning's own input, not a stubbed predicate.
    const created = await taskTools.find(t => t.name === "task_create")!
      .execute({ description: "Finish the migration", _sessionId: sessionId });
    expect(created.isError).not.toBe(true);

    await drive(op, ledgerThenEditAdapter);

    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");
    expect(vi.mocked(runBuildVerifyGate)).toHaveBeenCalled();
    // `endedPartial` won: the loud-partial warning is the last word and the
    // green line was never appended...
    const kinds = messageIdKinds(op.id);
    expect(kinds).toContain("open-steps-warn");
    expect(kinds).not.toContain("build-verify-ok");
    // ...so no fire was earned. A fire banked at the gate — where verifiedClean
    // was decided — would have counted a terminal nobody was shown. This is the
    // ONE assertion that separates the two possible wiring choices.
    expect(firesFor(op.id).filter(f => f.name === "build-verify")).toEqual([]);
  }, 20_000);

  it("`honest-terminal`'s two producers are separable by `name`, as the ledger promises", async () => {
    // guard-fire.ts admits the cost of reusing the value: it is now a census of
    // TWO producers, and says to slice by `name`. That is only true if the two
    // really do emit different names — proven here across the (a) op and the
    // clean (c) op, both driven through the real loop.
    setMiddlewareStack([]);
    const gateOp = mkOp("slice-gate");
    await drive(gateOp, () => leakingAdapter());

    setMiddlewareStack([verifyGateMiddleware]);
    scriptCleanBuild();
    const buildOp = mkOp("slice-build");
    trackOpForSession(buildOp.id, `sess-${buildOp.id}`);
    await drive(buildOp, editingAdapter);

    const census = [...firesFor(gateOp.id), ...firesFor(buildOp.id)]
      .filter(f => f.outcome === "honest-terminal")
      .map(f => f.name)
      .sort();
    expect(census).toEqual(["build-verify", "unresolved-tool-intent"]);
    // Two rows, one outcome, two names — the slice the ledger tells a
    // retirement review to make actually resolves them.
    expect(new Set(census).size).toBe(2);
  }, 30_000);
});

// ── The merged whole ─────────────────────────────────────────────────────

describe("E2 — the merged whole", () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  /** Every source file the campaign's four chunks added or changed. */
  const CAMPAIGN_FILES = [
    "src/canonical-loop/types.ts",
    "src/canonical-loop/turn-loop.ts",
    "src/canonical-loop/turn-loop/guard-fire.ts",
    "src/canonical-loop/turn-loop/decide-outcome.ts",
    "src/canonical-loop/turn-loop/decide-outcome-gates.ts",
    "src/canonical-loop/turn-loop/decide-outcome-verify-gates.ts",
    "src/canonical-loop/turn-loop/decide-outcome-gate-contract.ts",
    "src/canonical-loop/turn-loop/decide-outcome-run-gates.ts",
    "src/canonical-loop/turn-loop/terminal-epilogue.ts",
    "src/canonical-loop/turn-loop/nudges.ts",
    "src/canonical-loop/turn-loop/apply-directive.ts",
    "src/canonical-loop/turn-loop/suspension.ts",
    "src/canonical-loop/turn-loop/adapter-throw-recovery.ts",
    "src/canonical-loop/middlewares/office-theme-guard.ts",
  ];
  const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf-8");
  /** scripts/check-source-hygiene.mjs countLines, verbatim. */
  const countLines = (text: string): number => {
    const lines = text.split(/\r\n|\r|\n/);
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.length;
  };

  // SEAM 4. Two chunks each kept a file under the ceiling; only the merge can
  // say whether the ceiling still holds — and the file the split created is the
  // one a later chunk grew.
  it("every campaign source file stays inside the 400-LOC build ceiling", () => {
    const over = CAMPAIGN_FILES
      .map(rel => ({ rel, loc: countLines(read(rel)) }))
      .filter(f => f.loc > 400);
    expect(over).toEqual([]);
  });

  // SEAM 4, the other half: the gate 078a823c added, run over the merged tree
  // rather than over its own fixtures.
  it("every campaign source file clears the raw control byte / bidi gate", () => {
    const errors = CAMPAIGN_FILES.flatMap(rel => exoticCodePointErrors(rel, read(rel)));
    expect(errors).toEqual([]);
  });

  it("...and that gate has teeth on this repo's own build path", () => {
    // Non-vacuity for the two assertions above: the checker they call really
    // does reject what it claims to. Built with fromCharCode so THIS file stays
    // clean under the same gate.
    const NUL = String.fromCharCode(0x00);
    const RLO = String.fromCharCode(0x202e);
    expect(exoticCodePointErrors("src/probe.ts", `const a = "${NUL}";\n`)).toHaveLength(1);
    expect(exoticCodePointErrors("src/probe.ts", `const a = "${RLO}";\n`)).toHaveLength(1);
  });

  // SEAM 3. The split moved five gates into decide-outcome-verify-gates.ts and
  // the shared surface into decide-outcome-gate-contract.ts. Names alone would
  // pass if a copy were left behind, so this pins OBJECT IDENTITY: the table the
  // loop walks holds the very objects those modules export.
  it("the table the loop walks is assembled from BOTH gate modules, by identity", () => {
    expect(COMPLETION_GATE_ORDER).toEqual([
      "render-verify", "build-verify", "spec-probe", "spec-audit", "design-verify",
      "unresolved-tool-intent", "earned-done", "late-inject", "framework-serve",
    ]);
    const byName = new Map(COMPLETION_GATES.map(g => [g.name, g]));
    expect(byName.get("render-verify")).toBe(renderVerifyGate);
    expect(byName.get("build-verify")).toBe(buildVerifyGate);
    expect(byName.get("spec-probe")).toBe(specProbeGate);
    expect(byName.get("spec-audit")).toBe(specAuditGate);
    expect(byName.get("design-verify")).toBe(designVerifyGate);
    // The contract module is the leaf both sides share: the same CONTINUE
    // value and the same fire factory, or the "one table" claim is cosmetic.
    expect(CONTINUE.reopen).toBe(false);
    expect(gateSource("late-inject", "reopen"))
      .toEqual({ name: "late-inject", reason: "late-inject", outcome: "reopen" });
  });
});
