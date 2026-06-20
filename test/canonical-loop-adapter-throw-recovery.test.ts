/**
 * Adapter-throw recovery — a THROWN provider error (a timeout/stall the adapter
 * didn't convert into a kind:"error" report) must NOT hang the loop. driveTurn
 * captures it, feeds it back to the model as a continue-nudge, and retries
 * (bounded by ADAPTER_ERROR_CAP); after the cap it fails the op cleanly.
 *
 * Regression for the 2026-06-19 Grok-stall hang: "xai call threw: The operation
 * was aborted due to timeout" escaped driveTurn, the op never finalized, and the
 * chat "thinking…" spinner hung forever.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  canonicalLoopEntry,
  readCanonicalEvents,
  readOpMessages,
  registerAdapterForOp,
  resetCanonicalRuntime,
  resetScheduler,
  awaitIdle,
  resetBus,
} from "../src/canonical-loop/index.js";
import { newOpId } from "../src/ops/op-store.js";
import type { Op } from "../src/ops/types.js";
import { FakeAdapter, scriptTurn } from "./canonical-loop/fake-adapter.js";
import type { TurnPlan } from "./canonical-loop/fake-adapter.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const trackedIds: string[] = [];
const track = <T extends string>(id: T): T => { trackedIds.push(id); return id; };

beforeEach(() => { process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1"; });

afterEach(async () => {
  await awaitIdle(2_000).catch(() => undefined);
  resetScheduler();
  resetCanonicalRuntime();
  resetBus();
  for (const id of trackedIds) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
  trackedIds.length = 0;
  delete process.env.LAX_CANONICAL_LOOP_INTERACTIVE;
});

function mkOp(label: string): Op {
  return {
    id: track(newOpId(`throw_${label}`)),
    type: "freeform",
    task: `adapter-throw ${label}`,
    contextPack: {} as Op["contextPack"],
    lane: "interactive",
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test-throw",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

async function awaitTerminal(opId: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = readCanonicalEvents(opId);
    const last = [...events].reverse().find(e => e.type === "state_changed");
    const to = (last?.body as { to?: string } | null)?.to;
    if (to === "succeeded" || to === "failed" || to === "cancelled") return to;
    if (Date.now() > deadline) {
      throw new Error(`awaitTerminal timed out for ${opId} — events: [${events.map(e => e.type).join(", ")}]`);
    }
    await new Promise(r => setTimeout(r, 10));
  }
}

const throwingTurn = (msg: string): TurnPlan => ({ ...scriptTurn({}), throwInsteadOfReturning: new Error(msg) });

describe("adapter-throw recovery (feed-back-and-continue, bounded)", () => {
  it("recovers: one transient throw → continue-nudge → next turn succeeds", async () => {
    const op = mkOp("recover");
    const adapter = new FakeAdapter({ script: [
      throwingTurn("simulated provider timeout"),
      scriptTurn({ text: "recovered and finished", terminal: "done" }),
    ] });
    registerAdapterForOp(op.id, () => adapter);
    canonicalLoopEntry(op);

    const state = await awaitTerminal(op.id);
    expect(state).toBe("succeeded");            // auto-recovered — did NOT hang or fail
    expect(adapter.turnInputs.length).toBe(2);  // the throw + one retry

    // The error was fed back to the model as a synthetic user nudge.
    const userMsgs = readOpMessages(op.id).filter(m => m.role === "user");
    const nudge = userMsgs.find(m => ((m.content as { text?: string } | null)?.text ?? "").includes("transient provider error"));
    expect(nudge, "expected a continue-nudge user message").toBeDefined();
  });

  it("bounded: a hard-down provider FAILS the op after the cap, never hangs", async () => {
    const op = mkOp("bounded");
    const adapter = new FakeAdapter({ script: [
      throwingTurn("timeout"), throwingTurn("timeout"), throwingTurn("timeout"),
      throwingTurn("timeout"), throwingTurn("timeout"),
    ] });
    registerAdapterForOp(op.id, () => adapter);
    canonicalLoopEntry(op);

    const state = await awaitTerminal(op.id);
    expect(state).toBe("failed");               // terminal — NOT stuck running
    expect(adapter.turnInputs.length).toBe(3);  // original + 2 retries (cap=2), then give up

    const events = readCanonicalEvents(op.id);
    const exhausted = events.some(e => e.type === "error" && (e.body as { code?: string } | null)?.code === "adapter_error_exhausted");
    expect(exhausted, "expected an adapter_error_exhausted error event").toBe(true);
  });
});
