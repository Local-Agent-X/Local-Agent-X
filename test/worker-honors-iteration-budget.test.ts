/**
 * Regression — the worker must honor `contextPack.budget.maxIterations` (CL-7).
 *
 * The bug: worker.ts's drive loop capped turns at a hardcoded MAX_TURNS=64 and
 * never read the iteration budget the entry runner stamped. chat-runner and
 * agent-runner both set `budget.maxIterations` (e.g. chat defaults to 30), and
 * the loop's own comment claimed "Real cap is op budget" — but the loop ignored
 * it. A worker asked to cap at N would silently run up to 64 turns.
 *
 * The fix reads `op.contextPack.budget.maxIterations` and uses it as the cap,
 * falling back to the fixed floor only when the budget is absent / nonsensical.
 *
 * Real seam exercised: a genuine worker drives a real adapter whose every turn
 * is a non-terminal tool call (so the loop never terminates on its own) against
 * a live tool dispatcher. With a budget of 3, the worker must stop after exactly
 * 3 turns and finalize the interactive op as a successful checkpoint, not a
 * technical failure. Autonomous lanes use the same value as checkpoint cadence
 * and continue in the same worker.
 *
 * On OLD code (budget ignored, cap = 64): the 10-turn non-terminal script
 * exhausts at turn 11 → the adapter's default terminal turn ends the op
 * `succeeded` after ~11 turns. So this test's assertions (failed, 3 turns,
 * maxTurns=3) FAIL on the pre-fix code and PASS on the fix.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
} from "../src/canonical-loop/index.js";
import { readOp, newOpId } from "../src/ops/op-store.js";
import type { Op } from "../src/ops/types.js";

import { FakeAdapter, scriptTurn } from "./canonical-loop/fake-adapter.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];
const track = <T extends string>(id: T): T => { tracked.push(id); return id; };

beforeEach(() => {
  process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
  setLeaseConfig({ leaseDurationMs: 100, heartbeatIntervalMs: 25 });
});

afterEach(async () => {
  await awaitIdle(3_000).catch(() => undefined);
  resetScheduler();
  resetCanonicalRuntime();
  resetBus();
  resetLeaseConfig();
  for (const id of tracked) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  tracked.length = 0;
  delete process.env.LAX_CANONICAL_LOOP_INTERACTIVE;
});

function mkOp(maxIterations: number, lane: Op["lane"] = "interactive"): Op {
  return {
    id: track(newOpId("budget")),
    type: "freeform",
    task: "iteration-budget cap",
    // Only the budget path is read by the worker's cap logic.
    contextPack: {
      budget: { maxIterations, maxTokens: 0, maxWallTimeMs: 0, maxSelfEditCalls: 0 },
    } as Op["contextPack"],
    lane,
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test-iteration-budget",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

async function awaitTerminal(opId: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = readOp(opId)?.canonical?.state;
    if (s === "succeeded" || s === "failed" || s === "cancelled") return;
    if (Date.now() > deadline) return;
    await new Promise(r => setTimeout(r, 5));
  }
}

describe("worker honors budget.maxIterations (CL-7 regression)", () => {
  it("caps the drive loop at maxIterations, not the fixed 64 floor", async () => {
    const op = mkOp(3);

    // Every turn is a non-terminal, non-silent tool call: assistantText is
    // empty and terminalReason stays null, so the loop never ends on its own —
    // the ONLY thing that stops it is the iteration cap. Ten of them, well
    // under the old 64 floor, so if the budget were ignored the script would
    // instead run out and the adapter's default turn would end the op cleanly.
    const script = Array.from({ length: 10 }, (_, i) =>
      scriptTurn({ toolCalls: [{ toolCallId: `budget-tc-${i}`, tool: "search", args: {} }] }),
    );
    const fake = new FakeAdapter({ script });
    registerAdapterForOp(op.id, () => fake);

    // A benign tool dispatcher so each turn commits and the loop advances.
    setToolDispatcher({
      async dispatch(call) {
        return { toolCallId: call.toolCallId, status: "ok", result: { ok: true }, durationMs: 0 };
      },
    });

    canonicalLoopEntry(op);

    await awaitTerminal(op.id);
    await awaitIdle(5_000).catch(() => undefined);

    const after = readOp(op.id);

    expect(after?.canonical?.state).toBe("succeeded");

    // Exactly maxIterations driveTurn calls ran. On the fix count starts at 0,
    // runs turns 0/1/2, then the 4th iteration trips the cap before driveTurn.
    expect(fake.turnInputs.length).toBe(3);

    // The reason event quotes the BUDGET cap, proving it honored maxIterations
    // rather than the hardcoded floor.
    const events = readCanonicalEvents(op.id);
    const capEvent = events.find(e => e.type === "iteration_checkpoint");
    expect(capEvent).toBeDefined();
    expect(capEvent!.body).toMatchObject({ maxTurns: 3, continuing: false });
  });

  it("uses maxIterations as checkpoint cadence for unattended lanes", async () => {
    const op = mkOp(3, "background");
    const script = Array.from({ length: 5 }, (_, i) =>
      scriptTurn({ toolCalls: [{ toolCallId: `background-tc-${i}`, tool: "search", args: {} }] }),
    );
    const fake = new FakeAdapter({ script });
    registerAdapterForOp(op.id, () => fake);
    setToolDispatcher({
      async dispatch(call) {
        return { toolCallId: call.toolCallId, status: "ok", result: { ok: true }, durationMs: 0 };
      },
    });

    canonicalLoopEntry(op);
    await awaitTerminal(op.id);
    await awaitIdle(5_000).catch(() => undefined);

    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");
    expect(fake.turnInputs.length).toBeGreaterThan(3);
    const checkpoints = readCanonicalEvents(op.id).filter(e => e.type === "iteration_checkpoint");
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].body).toMatchObject({ maxTurns: 3, continuing: true });
  });
});
