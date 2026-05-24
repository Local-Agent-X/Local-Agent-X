/**
 * emitErrorOnce — per-op dedup for canonical `error` events.
 *
 * Bug 2026-05-24: a loop-detection middleware abort surfaced as TWO
 * identical "middleware-abort" bubbles in the IDE chat for a single user
 * turn. Root cause was suspected double-emit across the two error-emit
 * sites (turn-loop end-of-turn + nudges.middlewareAbortResult); the fix
 * collapses repeat (code, message) emits per op. These tests pin the
 * contract: same (code, message) twice → one persisted event; distinct
 * code or message → both persisted; cleared on terminal so re-using an
 * opId in tests doesn't leak state.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { newOpId, writeOp, readOp } from "../src/ops/op-store.js";
import type { Op } from "../src/ops/types.js";
import {
  emitErrorOnce,
  clearEmittedErrorsForOp,
  _resetEmittedErrors,
} from "../src/canonical-loop/event-emitter.js";
import { readCanonicalEvents } from "../src/canonical-loop/store.js";
import { transitionOp } from "../src/canonical-loop/state-machine.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];

function mkOp(label: string): Op {
  const id = newOpId(`emit_once_${label}`);
  tracked.push(id);
  const op: Op = {
    id,
    type: "freeform",
    task: `emit-once ${label}`,
    contextPack: {} as Op["contextPack"],
    lane: "interactive",
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test-emit-once",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
    canonical: { state: "queued" },
  };
  writeOp(op);
  return op;
}

beforeEach(() => {
  _resetEmittedErrors();
});

afterEach(() => {
  _resetEmittedErrors();
  for (const id of tracked) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  tracked.length = 0;
});

describe("emitErrorOnce — per-op dedup", () => {
  it("same (code, message) twice → one persisted error event", () => {
    const op = mkOp("dupe");
    const body = { code: "middleware-abort", message: "(No-progress abort: 15+ iterations…)", retryable: false };

    const first = emitErrorOnce(op.id, body);
    const second = emitErrorOnce(op.id, body);

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    const errors = readCanonicalEvents(op.id).filter(e => e.type === "error");
    expect(errors).toHaveLength(1);
    expect((errors[0].body as { code: string }).code).toBe("middleware-abort");
  });

  it("different codes for the same op both surface", () => {
    const op = mkOp("two-codes");
    const a = emitErrorOnce(op.id, { code: "stalled", message: "no adapter reports for 90000ms", retryable: false });
    const b = emitErrorOnce(op.id, { code: "middleware-abort", message: "loop", retryable: false });

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    const errors = readCanonicalEvents(op.id).filter(e => e.type === "error");
    expect(errors.map(e => (e.body as { code: string }).code)).toEqual(["stalled", "middleware-abort"]);
  });

  it("same code but different message both surface", () => {
    const op = mkOp("two-msgs");
    emitErrorOnce(op.id, { code: "middleware-abort", message: "loop detection fired", retryable: false });
    emitErrorOnce(op.id, { code: "middleware-abort", message: "dead-end fired", retryable: false });

    const errors = readCanonicalEvents(op.id).filter(e => e.type === "error");
    expect(errors).toHaveLength(2);
  });

  it("clearEmittedErrorsForOp resets the ledger so a re-emit lands", () => {
    const op = mkOp("clear");
    const body = { code: "middleware-abort", message: "loop", retryable: false };
    expect(emitErrorOnce(op.id, body)).not.toBeNull();
    expect(emitErrorOnce(op.id, body)).toBeNull();

    clearEmittedErrorsForOp(op.id);
    expect(emitErrorOnce(op.id, body)).not.toBeNull();

    const errors = readCanonicalEvents(op.id).filter(e => e.type === "error");
    expect(errors).toHaveLength(2);
  });

  it("terminal state_changed via transitionOp clears the ledger", () => {
    const op = mkOp("terminal");
    transitionOp(op, "running", "leased");
    const body = { code: "middleware-abort", message: "loop", retryable: false };
    expect(emitErrorOnce(op.id, body)).not.toBeNull();
    expect(emitErrorOnce(op.id, body)).toBeNull();

    transitionOp(op, "failed", "turn_error");

    expect(emitErrorOnce(op.id, body)).not.toBeNull();
    const errors = readCanonicalEvents(op.id).filter(e => e.type === "error");
    expect(errors).toHaveLength(2);
  });

  it("dedup is scoped per op (op A's emit does not affect op B)", () => {
    const opA = mkOp("scope-a");
    const opB = mkOp("scope-b");
    const body = { code: "middleware-abort", message: "loop", retryable: false };

    expect(emitErrorOnce(opA.id, body)).not.toBeNull();
    expect(emitErrorOnce(opB.id, body)).not.toBeNull();
    expect(emitErrorOnce(opA.id, body)).toBeNull();
    expect(emitErrorOnce(opB.id, body)).toBeNull();

    expect(readCanonicalEvents(opA.id).filter(e => e.type === "error")).toHaveLength(1);
    expect(readCanonicalEvents(opB.id).filter(e => e.type === "error")).toHaveLength(1);
  });
});

// Guard against the original bug: a single user turn that triggers a
// middleware-abort end-of-turn results in exactly one persisted error
// event even if both emit sites (nudges.middlewareAbortResult and
// turn-loop end-of-turn) were to fire back-to-back with the same body.
// Simulates the worst-case double-fire without instantiating the full
// turn-loop machinery.
describe("emitErrorOnce — guards the original double-bubble bug", () => {
  it("two back-to-back middleware-abort emits for the same op produce ONE event", () => {
    const op = mkOp("orig-bug");
    const middlewareAbortBody = {
      code: "middleware-abort",
      message: "(No-progress abort: 15+ iterations of tool calls with zero file mutations. Your work is either done or stuck. End the turn now.)",
      retryable: false,
    };

    emitErrorOnce(op.id, middlewareAbortBody);
    emitErrorOnce(op.id, middlewareAbortBody);

    const errors = readCanonicalEvents(op.id).filter(e => e.type === "error");
    expect(errors).toHaveLength(1);
    // Ensure the persisted op confirms it (sanity, op_store reads back).
    expect(readOp(op.id)?.id).toBe(op.id);
  });
});
