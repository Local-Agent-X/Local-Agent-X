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
 * A long-streaming interactive adapter that never finishes naturally is
 * submitted with a tiny budget. The worker must classify the deadline as a
 * failure, not misreport it as a user cancellation. Autonomous lanes are
 * governed by progress watchdogs and suspend resumable work instead.
 *
 * Now that maxIterations is a cadence rather than a wall, this deadline is the
 * backstop a user who walked away actually hits — so the chat-facing message
 * must be human (how long it ran, that the work is saved, how to continue)
 * while the terminal semantics stay exactly what soak-metrics and
 * learned-effectiveness assert: `failed` with reason `deadline_exceeded`.
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
import { createEventPump } from "../src/canonical-loop/chat-runner/event-pump.js";
import { readOp, newOpId } from "../src/ops/op-store.js";
import type { Op } from "../src/ops/types.js";
import type { ServerEvent } from "../src/types.js";

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

async function awaitState(opId: string, target: "failed", timeoutMs = 3_000): Promise<void> {
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
  it("fails an overrunning interactive op without classifying it as user-cancelled", async () => {
    const op = mkOp(100);
    const adapter = new FakeAdapter({
      script: [scriptLongStreamingTurn({ chunkIntervalMs: 25, maxChunks: 200 })],
    });
    registerAdapterForOp(op.id, () => adapter);

    canonicalLoopEntry(op);
    await awaitState(op.id, "failed", 3_000);

    const events = readCanonicalEvents(op.id);
    expect(events.some(e => e.type === "cancel_requested")).toBe(false);
    const deadline = events.find(e => e.type === "error" && e.body?.code === "deadline_exceeded");
    expect(deadline, "deadline_exceeded error missing").toBeDefined();
  });

  it("tells the chat user how long it ran and how to continue, while keeping deadline_exceeded semantics", async () => {
    const op = mkOp(100);
    const adapter = new FakeAdapter({
      script: [scriptLongStreamingTurn({ chunkIntervalMs: 25, maxChunks: 200 })],
    });
    registerAdapterForOp(op.id, () => adapter);

    // The real chat event pump, subscribed before the op starts — exactly what
    // chat-runner.ts does for a live session.
    const pump = createEventPump(op.id);
    const chat: ServerEvent[] = [];
    const drain = (async () => {
      for (;;) {
        const pulled = await pump.pull();
        chat.push(...pulled.events);
        if (pulled.terminal !== null) return pulled.terminal;
      }
    })();

    canonicalLoopEntry(op);
    await awaitState(op.id, "failed", 3_000);
    const terminal = await drain;
    pump.dispose();

    // Terminal semantics unchanged: failed, reason deadline_exceeded, code
    // deadline_exceeded, retryable — the mapping learned-effectiveness pins.
    expect(terminal).toBe("failed");
    const events = readCanonicalEvents(op.id);
    const stateChange = events.find((e: CanonicalEvent) => e.type === "state_changed" && e.body?.to === "failed");
    expect(stateChange?.body).toMatchObject({ reason: "deadline_exceeded" });
    const errorEvent = events.find(e => e.type === "error" && e.body?.code === "deadline_exceeded");
    expect(errorEvent?.body).toMatchObject({ retryable: true, maxWallTimeMs: 100 });
    expect(typeof errorEvent?.body?.elapsedMs).toBe("number");
    expect(errorEvent!.body!.elapsedMs as number).toBeGreaterThanOrEqual(100);

    // Chat-facing: no raw error bubble; a human stop line and one `stopped`.
    expect(chat.some(e => e.type === "error")).toBe(false);
    for (const e of chat) {
      if (e.type === "stream" && "delta" in e) expect(e.delta).not.toContain("maxWallTimeMs");
      if (e.type === "stopped") expect(e.reason).not.toContain("maxWallTimeMs");
    }
    const line = chat.find(e => e.type === "stream" && "delta" in e && typeof e.delta === "string" && e.delta.includes("The work so far is saved"));
    expect(line, "human deadline line missing from chat stream").toBeDefined();
    expect((line as { delta: string }).delta).toContain("say \"continue\"");
    const stops = chat.filter(e => e.type === "stopped");
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ firedBy: "wall-clock", debug: expect.stringContaining("deadline_exceeded") });
    expect((stops[0] as { reason: string }).reason).toContain("Say \"continue\"");
  });
});
