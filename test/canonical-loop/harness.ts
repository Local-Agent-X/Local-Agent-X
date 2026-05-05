/**
 * Acceptance harness for canonical-loop tests (Issue 02).
 *
 * Test substrate that submits ops, observes on-disk canonical state, and
 * asserts against expected event/turn/message timelines. Intentionally
 * decoupled from the loop runtime (Issue 03 onward) so harness self-tests
 * can land before the loop exists.
 *
 * Helpers offered (per Issue 02):
 *   submitOp(input, lane)               — invokes Issue 01 `canonicalLoopEntry` skeleton
 *   awaitState(opId, state, opts)       — polls canonical events for state_changed.to
 *   assertEvents(opId, expected)        — partial-match canonical event sequence
 *   assertOpTurns(opId, expected)       — partial-match committed turns
 *   assertOpMessages(opId, expected)    — partial-match canonical messages
 *   scriptTurn / scriptMultiTurn        — re-exported from fake-adapter.ts
 *   simulateCrash()                     — primitive for crash-recovery tests
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { expect } from "vitest";

import {
  canonicalLoopEntry,
  readCanonicalEvents,
  readLatestOpTurn,
  readOpTurn,
  readOpMessages,
  appendCanonicalEvent,
  insertOpTurn,
  appendOpMessage,
} from "../../src/canonical-loop/index.js";
import { writeOp, newOpId } from "../../src/workers/op-store.js";
import type { Op, OpLane } from "../../src/workers/types.js";
import type {
  CanonicalEvent,
  CanonicalEventType,
  CanonicalState,
  OpMessageRow,
  OpTurnRow,
} from "../../src/canonical-loop/index.js";

import { TestBus, BusRecorder } from "./bus-recorder.js";

export { scriptTurn, scriptMultiTurn, scriptLongStreamingTurn, FakeAdapter } from "./fake-adapter.js";
export { forwardStreamChunksToBus, TestBus, BusRecorder } from "./bus-recorder.js";
export { useFakeClock, useRealClock, advanceClock, clock } from "./clock.js";

const OPS_BASE = join(homedir(), ".lax", "operations");

// ── Op factory ───────────────────────────────────────────────────────────

export interface SubmitOpInput {
  task?: string;
  type?: string;
  lane?: OpLane;
  sessionId?: string;
}

let counter = 0;

function mkOp(input: SubmitOpInput = {}): Op {
  return {
    id: newOpId(`hop_${(counter++).toString(36)}`),
    type: input.type ?? "freeform",
    task: input.task ?? "harness test op",
    contextPack: {} as Op["contextPack"],
    lane: (input.lane ?? "interactive") as OpLane,
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test-harness",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

// ── Test context ─────────────────────────────────────────────────────────

export interface HarnessContext {
  bus: TestBus;
  recorder: BusRecorder;
  trackedIds: string[];
  cleanup: () => void;
}

export function createHarness(): HarnessContext {
  const bus = new TestBus();
  const recorder = new BusRecorder(bus);
  const trackedIds: string[] = [];
  const cleanup = () => {
    recorder.detach();
    bus.reset();
    for (const id of trackedIds) {
      const dir = join(OPS_BASE, id);
      if (existsSync(dir)) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
    trackedIds.length = 0;
  };
  return { bus, recorder, trackedIds, cleanup };
}

// ── submit / await ───────────────────────────────────────────────────────

/**
 * Submit an op through the Issue 01 `canonicalLoopEntry` skeleton — captures
 * `canonical.flagValue=true`, persists the op, emits one `state_changed`
 * event. The op stays `queued` until Issue 03 lights up the loop.
 *
 * Returns the persisted op so the test can read its id.
 */
export function submitOp(ctx: HarnessContext, input: SubmitOpInput = {}): Op {
  const op = mkOp(input);
  canonicalLoopEntry(op, input.sessionId ? { sessionId: input.sessionId } : {});
  ctx.trackedIds.push(op.id);
  return op;
}

export interface AwaitStateOpts {
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Poll canonical events for a `state_changed` whose `to` matches `state`.
 * Resolves on first match. Rejects with a clear error on timeout.
 */
export async function awaitState(
  opId: string,
  state: CanonicalState,
  opts: AwaitStateOpts = {},
): Promise<CanonicalEvent> {
  const timeout = opts.timeoutMs ?? 1_000;
  const interval = opts.pollMs ?? 10;
  const deadline = Date.now() + timeout;
  // Eager check before polling so already-queued ops resolve immediately.
  for (;;) {
    const found = findStateChange(opId, state);
    if (found) return found;
    if (Date.now() >= deadline) {
      const events = readCanonicalEvents(opId);
      const transitions = events
        .filter(e => e.type === "state_changed")
        .map(e => `${(e.body as { from: unknown }).from}→${(e.body as { to: unknown }).to}`);
      throw new Error(
        `awaitState timed out: op ${opId} did not reach '${state}' within ${timeout}ms. ` +
        `Observed transitions: [${transitions.join(", ")}]`,
      );
    }
    await new Promise(r => setTimeout(r, interval));
  }
}

function findStateChange(opId: string, target: CanonicalState): CanonicalEvent | null {
  const events = readCanonicalEvents(opId);
  for (const e of events) {
    if (e.type !== "state_changed") continue;
    const body = (e.body ?? {}) as { to?: CanonicalState };
    if (body.to === target) return e;
  }
  return null;
}

// ── Assertions ───────────────────────────────────────────────────────────

export interface ExpectedEvent {
  type: CanonicalEventType;
  /** Optional partial-body match. Top-level keys checked with `expect.objectContaining`. */
  body?: Record<string, unknown>;
  /** Optional explicit seq pin. */
  seq?: number;
}

/**
 * Assert that the canonical event log starts with the expected sequence (in
 * order, no gaps). Extra trailing events are allowed unless `strict=true`.
 */
export function assertEvents(opId: string, expected: ExpectedEvent[], opts: { strict?: boolean } = {}): void {
  const got = readCanonicalEvents(opId);
  if (opts.strict && got.length !== expected.length) {
    throw new Error(
      `assertEvents (strict): event-count mismatch — expected ${expected.length}, got ${got.length}. ` +
      `Full sequence: [${got.map(g => g.type).join(", ")}]`,
    );
  }
  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i];
    const actual = got[i];
    if (!actual) {
      throw new Error(`assertEvents: missing event at index ${i} (expected type='${exp.type}')`);
    }
    if (actual.type !== exp.type) {
      throw new Error(
        `assertEvents: event[${i}] type mismatch — expected '${exp.type}', got '${actual.type}'. ` +
        `Full sequence: [${got.map(g => g.type).join(", ")}]`,
      );
    }
    if (exp.seq !== undefined && actual.seq !== exp.seq) {
      throw new Error(
        `assertEvents: event[${i}] seq mismatch — expected ${exp.seq}, got ${actual.seq}`,
      );
    }
    if (exp.body) {
      for (const [k, v] of Object.entries(exp.body)) {
        const actualBody = (actual.body ?? {}) as Record<string, unknown>;
        if (actualBody[k] !== v) {
          throw new Error(
            `assertEvents: event[${i}] body.${k} mismatch — expected ${JSON.stringify(v)}, ` +
            `got ${JSON.stringify(actualBody[k])}`,
          );
        }
      }
    }
  }
  // Invariant: per-op seq is monotonic 0..N with no gaps.
  for (let i = 0; i < got.length; i++) {
    if (got[i].seq !== i) {
      throw new Error(
        `assertEvents: seq gap detected at index ${i} — events are not monotonic. ` +
        `seqs: [${got.map(g => g.seq).join(", ")}]`,
      );
    }
  }
}

export interface ExpectedTurn {
  turnIdx: number;
  terminalReason?: OpTurnRow["terminalReason"];
  redirectConsumed?: boolean;
}

export function assertOpTurns(opId: string, expected: ExpectedTurn[]): void {
  for (const exp of expected) {
    const actual = readOpTurn(opId, exp.turnIdx);
    if (!actual) {
      throw new Error(`assertOpTurns: turn ${exp.turnIdx} missing for op ${opId}`);
    }
    if (exp.terminalReason !== undefined && actual.terminalReason !== exp.terminalReason) {
      throw new Error(
        `assertOpTurns: turn ${exp.turnIdx} terminalReason — expected ${exp.terminalReason}, ` +
        `got ${actual.terminalReason}`,
      );
    }
    if (exp.redirectConsumed !== undefined && actual.redirectConsumed !== exp.redirectConsumed) {
      throw new Error(
        `assertOpTurns: turn ${exp.turnIdx} redirectConsumed — expected ${exp.redirectConsumed}, ` +
        `got ${actual.redirectConsumed}`,
      );
    }
  }
  const latest = readLatestOpTurn(opId);
  if (expected.length > 0) {
    expect(latest?.turnIdx).toBe(expected[expected.length - 1].turnIdx);
  }
}

export interface ExpectedMessage {
  turnIdx: number;
  seqInTurn: number;
  role: OpMessageRow["role"];
}

export function assertOpMessages(opId: string, expected: ExpectedMessage[]): void {
  const got = readOpMessages(opId);
  for (const exp of expected) {
    const match = got.find(
      m => m.turnIdx === exp.turnIdx && m.seqInTurn === exp.seqInTurn,
    );
    if (!match) {
      throw new Error(
        `assertOpMessages: missing message at turn=${exp.turnIdx} seq=${exp.seqInTurn}`,
      );
    }
    if (match.role !== exp.role) {
      throw new Error(
        `assertOpMessages: turn=${exp.turnIdx} seq=${exp.seqInTurn} role — ` +
        `expected ${exp.role}, got ${match.role}`,
      );
    }
  }
}

// ── Synthetic event/turn/message writers (for harness self-tests) ────────
// Issue 03 wires the real loop. Until then, harness tests construct the
// expected timeline directly and assert against it.

export function injectStateChange(opId: string, from: CanonicalState | null, to: CanonicalState, reason = "test"): void {
  appendCanonicalEvent(opId, "state_changed", { from, to, reason });
}

export function injectEvent(opId: string, type: CanonicalEventType, body: Record<string, unknown> | null = null): void {
  appendCanonicalEvent(opId, type, body);
}

export function injectTurn(row: OpTurnRow): void {
  insertOpTurn(row);
}

export function injectMessage(row: OpMessageRow): void {
  appendOpMessage(row);
}

// ── Crash simulation ─────────────────────────────────────────────────────

/**
 * Simulate a worker crash mid-turn. The returned promise rejects with
 * `Error("crash")` after `delayMs`. Issue 08 will use this to validate
 * lease expiry / re-lease semantics; Issue 02 ships the primitive only.
 */
export function simulateCrash(delayMs = 5): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error("crash")), delayMs);
  });
}

/**
 * Race a long-running adapter promise against a crash. Returns whichever
 * resolves/rejects first.
 */
export function withCrash<T>(work: Promise<T>, delayMs = 5): Promise<T> {
  return Promise.race([work, simulateCrash(delayMs)]);
}

// ── Persisted op convenience ─────────────────────────────────────────────

/** Persist an op without invoking canonical-loop — used in tests that just need an op row. */
export function makeAndPersistOp(ctx: HarnessContext, input: SubmitOpInput = {}): Op {
  const op = mkOp(input);
  writeOp(op);
  ctx.trackedIds.push(op.id);
  return op;
}
