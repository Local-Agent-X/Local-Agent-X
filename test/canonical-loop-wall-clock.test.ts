/**
 * Wall-clock ceiling enforcement.
 *
 * Regression guard: the wall-clock cap must be enforced inside the worker
 * (the one place every entry path converges), driven by the op's
 * `budget.maxWallTimeMs`. Before this lived only in agent-runner's private
 * timer, so chat turns — which run the same worker but never armed that
 * timer — could overrun their budget indefinitely (the 2026-06-01 nudge
 * runaway that ran ~6 minutes past a 5-minute cap).
 *
 * A long-streaming adapter that never finishes naturally is submitted with a
 * tiny budget; the worker must fire opCancel("wall-clock-ceiling") and the op
 * must reach `cancelled`.
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
  readCanonicalEvents,
  type CanonicalEvent,
} from "../src/canonical-loop/index.js";
import { readOp, newOpId } from "../src/ops/op-store.js";
import type { Op } from "../src/ops/types.js";

import { FakeAdapter, scriptLongStreamingTurn } from "./canonical-loop/fake-adapter.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];
const track = <T extends string>(id: T): T => { tracked.push(id); return id; };

beforeEach(() => {
  process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
});

afterEach(async () => {
  await awaitIdle(3_000).catch(() => undefined);
  resetScheduler();
  resetCanonicalRuntime();
  resetBus();
  for (const id of tracked) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  tracked.length = 0;
  delete process.env.LAX_CANONICAL_LOOP_INTERACTIVE;
});

function mkOp(maxWallTimeMs: number): Op {
  return {
    id: track(newOpId("wallclock")),
    type: "freeform",
    task: "wall-clock ceiling",
    contextPack: { budget: { maxWallTimeMs } } as Op["contextPack"],
    lane: "interactive",
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test-wall-clock",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

async function awaitState(opId: string, target: "cancelled", timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const op = readOp(opId);
    if (op?.canonical?.state === target) return;
    if (Date.now() > deadline) {
      const events = readCanonicalEvents(opId).map(e => e.type).join(",");
      throw new Error(`awaitState(${target}) timed out for ${opId} — events=[${events}], state=${op?.canonical?.state}`);
    }
    await new Promise(r => setTimeout(r, 5));
  }
}

describe("canonical-loop — wall-clock ceiling", () => {
  it("cancels an overrunning op via the worker using the op's budget", async () => {
    const op = mkOp(100);
    const adapter = new FakeAdapter({
      script: [scriptLongStreamingTurn({ chunkIntervalMs: 25, maxChunks: 200 })],
    });
    registerAdapterForOp(op.id, () => adapter);

    canonicalLoopEntry(op);
    await awaitState(op.id, "cancelled", 3_000);

    const events = readCanonicalEvents(op.id);
    const cancelReq = events.find(e => e.type === "cancel_requested");
    expect(cancelReq, "cancel_requested missing — ceiling never fired").toBeDefined();
    const body = (cancelReq?.body ?? {}) as { actor?: string };
    expect(body.actor).toBe("wall-clock-ceiling");
  });
});
