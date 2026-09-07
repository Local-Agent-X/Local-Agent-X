/**
 * The wall clock binds on EVERY lane, from the op's own maxWallTimeMs.
 *
 * worker.ts armed its deadline timer for `interactive` only. A build or
 * background worker in a livelock the cycle detector cannot see — period 9
 * (detectCycle's MAX_PERIOD is 8), a jittered argument every lap, and one
 * trivially novel result per lap so the dry checkpoint always sees fresh
 * evidence — was invisible to every other brake and ran unbounded: 700+
 * turns on a subscription login where the spend ceiling never binds, with a
 * 15-minute maxWallTimeMs stamped on the op (ops/tools/shared.ts) and
 * enforced nowhere.
 *
 * ARMING A TIMER IS NOT ENOUGH, and this file is the proof. A turn whose
 * every await settles as a microtask — local tools, synchronous op-store
 * writes — never returns control to the macrotask phase, so no setTimeout in
 * the process can fire while the loop keeps turning. That is precisely the
 * shape of the livelock the brake exists for. The first version of this test
 * pegged a core for hours and took the vitest runner with it because the only
 * enforcement was a setTimeout the starved loop never let run; `timerFired`
 * below is that fact, asserted. The brake is the SYNCHRONOUS turn-boundary
 * check in worker.ts; the armed timer is only the mid-turn preempt.
 *
 * On expiry a non-interactive op ends the way a checkpoint stop does — an
 * `iteration_checkpoint { continuing: false, stopReason: "wall-clock" }`
 * record and `succeeded / iteration_checkpoint`, learnedOutcome partial — so
 * every partial reader (op_wait here; the observer and the phone projection
 * read the same record through resolveTerminalOpStatus) renders the PARTIAL
 * line unchanged. Not `failed`: the committed turns are saved. The
 * interactive lane's `failed / deadline_exceeded` path and its 2h chat
 * message are pinned unchanged by test/canonical-loop-wall-clock.test.ts.
 *
 * Real seam: a genuine worker drives a scripted adapter against a live
 * dispatcher with the REAL loop-detection middleware installed, so the
 * "nothing else stops this" claim is made by production code.
 *
 * HARNESS NOTE — keep SCRIPT_TURNS small. It is the only bound left when the
 * brake regresses, and each turn costs more than the last (history grows). A
 * five-thousand-turn script turns a red test into an hours-long hang.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { setMiddlewareStack, _resetMiddlewareStack } from "../src/canonical-loop/middlewares/host.js";
import { loopDetectionMiddleware } from "../src/canonical-loop/middlewares/loop-detection.js";
import { getRuntimeConfig, setRuntimeConfig } from "../src/config.js";
import {
  canonicalLoopEntry,
  registerAdapterForOp,
  resetCanonicalRuntime,
  resetScheduler,
  awaitIdle,
  resetBus,
  setLeaseConfig,
  resetLeaseConfig,
  setToolDispatcher,
  readCanonicalEvents,
  awaitCanonicalOp,
} from "../src/canonical-loop/index.js";
import { wallClockBudgetMs } from "../src/canonical-loop/worker-wall-clock.js";
import { readOp, newOpId } from "../src/ops/op-store.js";
import { opWaitTool } from "../src/ops/tools/op-wait.js";
import type { Op } from "../src/ops/types.js";
import { FakeAdapter, scriptTurn } from "./canonical-loop/fake-adapter.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];
const ORIGINAL_CONFIG = getRuntimeConfig();

/** The op's whole budget. Long enough to commit several real turns on a busy
 *  box, short enough that the case finishes in well under the file timeout. */
const WALL_CLOCK_MS = 400;
/** See HARNESS NOTE. The op must never reach the end of this script. */
const SCRIPT_TURNS = 60;

beforeEach(() => {
  process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
  setLeaseConfig({ leaseDurationMs: 100, heartbeatIntervalMs: 25 });
  setMiddlewareStack([loopDetectionMiddleware]);
  // The spend ceiling reads the real ~/.lax ledger; the outcome here must be
  // decided by the wall clock alone (see worker-honors-iteration-budget).
  setRuntimeConfig({ ...ORIGINAL_CONFIG, dailyBudgetUsd: 0, sessionBudgetUsd: 0 });
});

afterEach(async () => {
  await awaitIdle(3_000).catch(() => undefined);
  resetScheduler();
  resetCanonicalRuntime();
  resetBus();
  resetLeaseConfig();
  _resetMiddlewareStack();
  setRuntimeConfig(ORIGINAL_CONFIG);
  for (const id of tracked) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
  tracked.length = 0;
  delete process.env.LAX_CANONICAL_LOOP_INTERACTIVE;
});

function mkOp(lane: Op["lane"], maxWallTimeMs: number): Op {
  const id = newOpId("wallclock-lane");
  tracked.push(id);
  return {
    id,
    type: "freeform",
    task: "period-9 livelock on a worker lane",
    // A large cadence so the dry checkpoint never decides this op.
    contextPack: {
      budget: { maxIterations: 10_000, maxTokens: 0, maxWallTimeMs, maxSelfEditCalls: 0 },
    } as Op["contextPack"],
    lane,
    model: "claude-opus-4-8",
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test-wall-clock-lane",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

/** Period 9 — one step past detectCycle's MAX_PERIOD — with a jittered
 *  argument every lap. Nine distinct non-mutating, non-discovery tools so no
 *  exact-repeat / mutation-repeat / discovery path sees anything either. */
const PERIOD = 9;
function livelockScript(turns: number) {
  return Array.from({ length: turns }, (_, i) => {
    const lap = Math.floor(i / PERIOD);
    const step = i % PERIOD;
    return scriptTurn({
      toolCalls: [{ toolCallId: `p9-${i}`, tool: `probe_${step}`, args: { step, lap, jitter: (lap * 7 + step) % 5 } }],
    });
  });
}

async function awaitTerminal(opId: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = readOp(opId)?.canonical?.state;
    if (s === "succeeded" || s === "failed" || s === "cancelled") return;
    if (Date.now() > deadline) return;
    await new Promise(r => setTimeout(r, 5));
  }
}

describe("wall clock on every lane — a period-9 livelock ends partial, reason wall-clock", () => {
  it.each(["build", "background"] as const)("%s lane: ends succeeded / iteration_checkpoint with the wall-clock record, and op_wait opens with PARTIAL", async (lane) => {
    const op = mkOp(lane, WALL_CLOCK_MS);
    const fake = new FakeAdapter({ script: livelockScript(SCRIPT_TURNS) });
    registerAdapterForOp(op.id, () => fake);
    // One trivially novel result per lap (the first probe), identical bytes
    // for the other eight: the dry checkpoint would always see progress.
    setToolDispatcher({
      async dispatch(call) {
        const args = call.args as { step: number; lap: number };
        const text = args.step === 0 ? `lap ${args.lap} started` : "nothing changed";
        return { toolCallId: call.toolCallId, status: "ok", result: { text }, durationMs: 0 };
      },
    });

    // A macrotask armed for the same deadline. It must NOT be what stops the
    // op — see the header: while the worker drives a fully synchronous turn
    // the timer phase is never reached, which is why the enforcement is a
    // synchronous turn-boundary check and not this.
    let timerFired = false;
    const starvationWitness = setTimeout(() => { timerFired = true; }, WALL_CLOCK_MS);

    const startedAt = Date.now();
    canonicalLoopEntry(op);
    await awaitTerminal(op.id);
    const stoppedAfterMs = Date.now() - startedAt;
    clearTimeout(starvationWitness);
    await awaitIdle(5_000).catch(() => undefined);

    const row = readOp(op.id);
    expect(row?.canonical?.state).toBe("succeeded");
    // The clock stopped it, not the script running out — and it did so promptly.
    expect(fake.turnInputs.length).toBeGreaterThan(0);
    expect(fake.turnInputs.length).toBeLessThan(SCRIPT_TURNS);
    expect(stoppedAfterMs).toBeLessThan(8_000);
    // The mechanism, pinned: the op was already terminal before the event
    // loop ever reached its timer phase. Re-arming this as a setTimeout only
    // (the shipped-and-reverted design) hangs the runner instead of failing.
    expect(timerFired).toBe(false);

    const events = readCanonicalEvents(op.id);
    const stateChange = events.find(e => e.type === "state_changed" && e.body?.to === "succeeded");
    expect(stateChange?.body).toMatchObject({ reason: "iteration_checkpoint" });
    // Not the interactive shape: no deadline_exceeded error, nothing failed.
    expect(events.some(e => e.type === "error" && e.body?.code === "deadline_exceeded")).toBe(false);
    const stop = events.filter(e => e.type === "iteration_checkpoint").at(-1)!;
    expect(stop.body).toMatchObject({ continuing: false, stopReason: "wall-clock", maxTurns: 10_000 });
    expect(String(stop.body?.stopDetail)).toContain(`maxWallTimeMs=${WALL_CLOCK_MS}`);

    // The parent-facing PARTIAL surface, from the same record.
    expect((await awaitCanonicalOp(op.id, 1_000))?.status).toBe("partial");
    const waited = await opWaitTool.execute({ op_id: op.id, timeout_ms: 1_000 });
    expect(waited.isError).toBe(false);
    expect(waited.content).toMatch(new RegExp(`^PARTIAL — child op ${op.id} stopped at a checkpoint after \\d+ turns \\(reason: wall-clock: ran for`));
    expect(waited.content).toContain("NOT finished");
  });
});

describe("wallClockBudgetMs — what arms the timer", () => {
  const withBudget = (maxWallTimeMs: unknown): Op =>
    ({ contextPack: { budget: { maxWallTimeMs } } } as unknown as Op);
  it("a positive finite budget arms; 0 (tools/build-app.ts), NaN, negative and absent never do", () => {
    expect(wallClockBudgetMs(withBudget(15 * 60 * 1000))).toBe(900_000);
    expect(wallClockBudgetMs(withBudget(0))).toBeNull();
    expect(wallClockBudgetMs(withBudget(Number.NaN))).toBeNull();
    expect(wallClockBudgetMs(withBudget(Number.POSITIVE_INFINITY))).toBeNull();
    expect(wallClockBudgetMs(withBudget(-1))).toBeNull();
    expect(wallClockBudgetMs(withBudget(undefined))).toBeNull();
    expect(wallClockBudgetMs({} as Op)).toBeNull();
  });
});
