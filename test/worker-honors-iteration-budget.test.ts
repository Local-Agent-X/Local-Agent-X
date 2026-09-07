/**
 * Regression — the worker must honor `contextPack.budget.maxIterations` (CL-7),
 * and must treat it as a CADENCE rather than a wall.
 *
 * The original bug: worker.ts's drive loop capped turns at a hardcoded
 * MAX_TURNS=64 and never read the iteration budget the entry runner stamped.
 * A worker asked to cap at N would silently run up to 64 turns. The fix reads
 * `op.contextPack.budget.maxIterations`, falling back to the fixed floor only
 * when the budget is absent / nonsensical — every case below still asserts the
 * op's own budget (3) is the number the checkpoint quotes.
 *
 * The second bug, fixed here: `maxIterations` was a hard WALL for the
 * `interactive` lane and a mere cadence for every other lane. The wall ended a
 * chat at an arbitrary turn count that said nothing about whether the work was
 * finished or whether the op was stuck — a user who walked away came back to an
 * unfinished task with no explanation. It is now a cadence for EVERY lane, and
 * whether the op ends at a checkpoint is decided by checkpoint-stop.ts.
 *
 * Real seam exercised: a genuine worker drives a real adapter whose every turn
 * is a non-terminal tool call (so the loop never terminates on its own) against
 * a live tool dispatcher, with the REAL loop-detection middleware installed so
 * the "did we learn anything" counter is advanced by production code rather
 * than seeded by the test.
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
} from "../src/canonical-loop/index.js";
import { readOp, newOpId } from "../src/ops/op-store.js";
import type { Op } from "../src/ops/types.js";
import { awaitCanonicalOp } from "../src/canonical-loop/index.js";
import { opWaitTool } from "../src/ops/tools/op-wait.js";
import { opStatusTool } from "../src/ops/tools/op-status.js";

import { FakeAdapter, scriptTurn } from "./canonical-loop/fake-adapter.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];
const track = <T extends string>(id: T): T => { tracked.push(id); return id; };
const ORIGINAL_CONFIG = getRuntimeConfig();

beforeEach(() => {
  process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
  setLeaseConfig({ leaseDurationMs: 100, heartbeatIntervalMs: 25 });
  // The dry-checkpoint condition reads loop-detection's novelty counter.
  // Install the REAL middleware (only that one — the full default stack would
  // nudge/abort the scripted adapter for unrelated reasons) so the evidence
  // this test turns on is recorded by production code.
  setMiddlewareStack([loopDetectionMiddleware]);
  // These cases are about the DRY condition. The spend ceiling is on by
  // default and reads the real ~/.lax usage ledger, which on a developer box
  // may already be over today's budget — disable it so the outcome here is
  // decided by evidence alone. The spend condition has its own coverage in
  // src/canonical-loop/checkpoint-stop.test.ts on an isolated ledger.
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
  it("treats maxIterations as a cadence for the interactive lane while work progresses", async () => {
    // maxIterations used to be a hard WALL for `interactive` — the op died at
    // an arbitrary turn count that said nothing about whether the work was
    // done. It is now a checkpoint cadence for every lane; termination is
    // decided by checkpoint-stop.ts. With every turn producing a NEW distinct
    // tool result, no stop condition is met, so the op must run past the
    // 3-turn budget and only end when the script runs out.
    const op = mkOp(3);

    const script = Array.from({ length: 10 }, (_, i) =>
      scriptTurn({ toolCalls: [{ toolCallId: `budget-tc-${i}`, tool: "search", args: { q: `q-${i}` } }] }),
    );
    const fake = new FakeAdapter({ script });
    registerAdapterForOp(op.id, () => fake);

    // Distinct result bytes per call, so loop-detection's novelty counter
    // advances every turn and no checkpoint is ever "dry".
    let n = 0;
    setToolDispatcher({
      async dispatch(call) {
        return { toolCallId: call.toolCallId, status: "ok", result: { ok: true, finding: `distinct-finding-${n++}` }, durationMs: 0 };
      },
    });

    canonicalLoopEntry(op);

    await awaitTerminal(op.id);
    await awaitIdle(5_000).catch(() => undefined);

    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");
    // Ran WELL past the 3-turn budget — the wall is gone.
    expect(fake.turnInputs.length).toBeGreaterThan(3);

    // Every checkpoint it did pass was a continuing cadence marker, and the
    // budget it quotes is still the op's, not the hardcoded 64 floor.
    const checkpoints = readCanonicalEvents(op.id).filter(e => e.type === "iteration_checkpoint");
    expect(checkpoints.length).toBeGreaterThanOrEqual(2);
    for (const c of checkpoints) expect(c.body).toMatchObject({ maxTurns: 3, continuing: true });

    // A genuinely finished op is still `completed` to a parent — continuing
    // checkpoints along the way do not make it partial.
    expect((await awaitCanonicalOp(op.id, 1_000))?.status).toBe("completed");
    const waited = await opWaitTool.execute({ op_id: op.id, timeout_ms: 1_000 });
    expect(waited.isError).toBe(false);
    expect(waited.content).not.toMatch(/^PARTIAL/);
  });

  // A checkpoint stop is `succeeded / iteration_checkpoint` on the state
  // machine; await-op mapped succeeded → "completed" and op_wait returned the
  // child's last text with isError:false, so a parent built on a half-done
  // result with no idea it was one. The stop must reach the parent as PARTIAL.
  it("reports a worker-lane child that stopped at a dry checkpoint as PARTIAL to its parent", async () => {
    const op = mkOp(3, "build");
    const script = Array.from({ length: 20 }, (_, i) =>
      scriptTurn({ toolCalls: [{ toolCallId: `partial-tc-${i}`, tool: "search", args: {} }] }),
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
    const stop = readCanonicalEvents(op.id).filter(e => e.type === "iteration_checkpoint").at(-1)!;
    expect(stop.body).toMatchObject({ continuing: false, stopReason: "dry-checkpoints" });
    const completedTurns = (stop.body as { completedTurns: number }).completedTurns;

    // The parent-facing result: `partial`, never `completed`.
    const result = await awaitCanonicalOp(op.id, 1_000);
    expect(result?.status).toBe("partial");

    // op_wait: not an error (the work is saved), but the content MUST open
    // with the explicit PARTIAL line — before any of the child's own text.
    const waited = await opWaitTool.execute({ op_id: op.id, timeout_ms: 1_000 });
    expect(waited.isError).toBe(false);
    expect(waited.content).toMatch(
      new RegExp(`^PARTIAL — child op ${op.id} stopped at a checkpoint after ${completedTurns} turns \\(reason: dry-checkpoints`),
    );
    expect(waited.content).toContain(`op ${op.id} partial in`);

    // op_status says the same thing, from the same record.
    const status = await opStatusTool.execute({ op_id: op.id });
    expect(status.isError).toBeFalsy();
    expect(status.content).toContain(`op ${op.id} [partial]`);
    expect(status.content).toContain(`PARTIAL — child op ${op.id} stopped at a checkpoint after ${completedTurns} turns (reason: dry-checkpoints`);
  });

  it("stops an interactive op at the checkpoint where two in a row learned nothing", async () => {
    // Same script, but the dispatcher returns the IDENTICAL result every time,
    // so loop-detection's novelty counter stops moving after turn 0.
    // Checkpoint 1 has no prior count to compare; checkpoints 2 and 3 are both
    // dry, which is the stop.
    const op = mkOp(3);

    const script = Array.from({ length: 20 }, (_, i) =>
      scriptTurn({ toolCalls: [{ toolCallId: `dry-tc-${i}`, tool: "search", args: {} }] }),
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
    // Stopped well before the 20-turn script ran out, and after more than one
    // checkpoint — proof it was the dry condition and not the old wall.
    expect(fake.turnInputs.length).toBeGreaterThan(3);
    expect(fake.turnInputs.length).toBeLessThan(20);

    const checkpoints = readCanonicalEvents(op.id).filter(e => e.type === "iteration_checkpoint");
    expect(checkpoints).toHaveLength(3);
    const last = checkpoints.at(-1)!;
    expect(last.body).toMatchObject({ maxTurns: 3, continuing: false, stopReason: "dry-checkpoints" });
    expect(checkpoints.slice(0, -1).every(c => c.body?.continuing === true)).toBe(true);

    // Terminal semantics soak-metrics / learned-effectiveness depend on: a
    // checkpoint stop is `succeeded` with the literal reason.
    const terminal = readCanonicalEvents(op.id).find(e => e.type === "state_changed" && e.body?.to === "succeeded");
    expect(terminal?.body).toMatchObject({ reason: "iteration_checkpoint" });
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
