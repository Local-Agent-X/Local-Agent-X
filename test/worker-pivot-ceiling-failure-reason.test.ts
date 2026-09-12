/**
 * A middleware abort must leave a failure REASON on the op row.
 *
 * The strategy-pivot ceiling (middlewares/strategy-pivot.ts) ends a worker
 * that has cycled through all four strategies with no new information. The
 * turn loop turned that abort into terminalReason:"error", commitTurn
 * transitioned the op `failed / turn_error` — and op.lastFailureReason stayed
 * unset, so the chat card, op_wait and the phone projection all said just
 * "failed". The abort's own note (which names the cycle) never reached the
 * row. It now rides the commit envelope as `failureReason` and is stamped
 * onto the op at the failed transition.
 *
 * Real seam: a genuine worker drives a scripted adapter that replays the
 * recorded livelock (LIVELOCK_SHAPES — renamed scratch file every lap, the
 * same result every time) against a live dispatcher with the REAL
 * loop-detection middleware, so the abort is produced by production code.
 * Medium tier: cycle detection needs two laps, so the ceiling trips at turn
 * 68 (index 67 — loop-detection.livelock.test.ts) instead of 366.
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
} from "../src/canonical-loop/index.js";
import { readOp, newOpId } from "../src/ops/op-store.js";
import type { Op } from "../src/ops/types.js";
import { LIVELOCK_SHAPES } from "../src/agent-guards/livelock-shapes.test-helper.js";
import { FakeAdapter, scriptTurn } from "./canonical-loop/fake-adapter.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];
const ORIGINAL_CONFIG = getRuntimeConfig();

beforeEach(() => {
  process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
  setLeaseConfig({ leaseDurationMs: 100, heartbeatIntervalMs: 25 });
  setMiddlewareStack([loopDetectionMiddleware]);
  // The spend ceiling reads the real ~/.lax ledger; the outcome here must be
  // decided by the loop guard alone (see worker-honors-iteration-budget).
  setRuntimeConfig({ ...ORIGINAL_CONFIG, dailyBudgetUsd: 0, sessionBudgetUsd: 0 });
  // The same bytes for every call: nothing the worker does is ever novel.
  setToolDispatcher({
    async dispatch(call) {
      return { toolCallId: call.toolCallId, status: "ok", result: { text: "Both fixes are live on prod." }, durationMs: 0 };
    },
  });
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

function mkOp(): Op {
  const id = newOpId("livelock");
  tracked.push(id);
  return {
    id,
    type: "freeform",
    task: "replay the recorded livelock on the build lane",
    // A large cadence so the dry checkpoint never decides this op; the
    // renamed scratch files keep the progress counter moving anyway.
    contextPack: {
      budget: { maxIterations: 500, maxTokens: 0, maxWallTimeMs: 0, maxSelfEditCalls: 0 },
    } as Op["contextPack"],
    lane: "build",
    model: "qwen3:32b", // loopGuardTier → medium
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test-pivot-ceiling-reason",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

/** The recorded shapes, renamed scratch file every turn, enough laps to
 *  outlast the medium-tier ceiling several times over. */
function livelockScript(turns: number) {
  return Array.from({ length: turns }, (_, i) => {
    const names = LIVELOCK_SHAPES[i % LIVELOCK_SHAPES.length].split(",");
    return scriptTurn({
      toolCalls: names.map((tool, j) => ({
        toolCallId: `ll-${i}-${j}`,
        tool,
        args: { path: `/w/_scratch-${i}-${j}.html`, url: `https://x/${i}` },
      })),
    });
  });
}

async function awaitTerminal(opId: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = readOp(opId)?.canonical?.state;
    if (s === "succeeded" || s === "failed" || s === "cancelled") return;
    if (Date.now() > deadline) return;
    await new Promise(r => setTimeout(r, 5));
  }
}

describe("a pivot-ceiling abort fails the op WITH a reason that names the cycle", () => {
  // A real dispatcher drives 300 synchronous turns through production
  // loop-detection — the same event-loop-starvation shape as
  // worker-wall-clock-every-lane.test.ts, where a turn's own synchronous
  // processing can outrun a poll loop's setTimeout ticks, so the "20s"
  // budget below is 20s of CHECKED time, not a hard wall-clock cap.
  // Measured on windows-latest CI (same run as this fix): this test took at
  // LEAST 36.7s before vitest's prior 30s outer timeout could even
  // interrupt it — and that interrupt itself needs an event-loop tick, so
  // the true natural completion time on that runner could be longer still.
  // Local runs finish in ~12s. Sized with real margin above the observed
  // floor rather than the local number.
  it("op.lastFailureReason carries the ceiling note after the worker is aborted", async () => {
    const op = mkOp();
    const fake = new FakeAdapter({ script: livelockScript(300) });
    registerAdapterForOp(op.id, () => fake);

    canonicalLoopEntry(op);
    await awaitTerminal(op.id);
    await awaitIdle(5_000).catch(() => undefined);

    const row = readOp(op.id);
    expect(row?.canonical?.state).toBe("failed");
    // The ceiling fired, not the script running out.
    expect(fake.turnInputs.length).toBeLessThan(300);
    expect(row?.lastFailureReason).toMatch(/strategy-pivot ceiling/i);
    expect(row?.lastFailureReason).toMatch(/the same cycle keeps repeating/);
    expect(row?.lastFailureReason).toContain("no-progress");
    // Stored trimmed: the stream note's leading blank lines are presentation.
    expect(row?.lastFailureReason?.startsWith("(")).toBe(true);
  }, 90_000);
});
