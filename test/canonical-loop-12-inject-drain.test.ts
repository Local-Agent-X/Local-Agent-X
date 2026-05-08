/**
 * Issue 12 — mid-turn inject drain on the canonical chat path.
 *
 * The legacy agent-loop has `interjectDrainMiddleware` that pulls from the
 * per-session FIFO at the start of each iteration; the canonical-loop
 * needs the equivalent so chat ops driven by `canonicalLoopEntry` see
 * mid-turn user messages on the next turn boundary.
 *
 * Acceptance:
 *   - A `pushInject(sessionId, "...")` call landing during turn 0 is
 *     visible to the adapter on turn 1 as a user-role message in
 *     `TurnInput.messages` (so the model actually reads it).
 *   - The inject is persisted as an op_messages row with role=user and the
 *     upcoming turnIdx; a `message_appended` event is emitted.
 *   - Drain is gated on `op.type === "chat_turn"` — a freeform/worker op
 *     for the same session does NOT consume the queue.
 *   - With no injects pending, behavior is identical to the pre-change
 *     path (no extra rows, no extra events).
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
  subscribeOpEvents,
  subscribeOpStream,
  readCanonicalEvents,
  type CanonicalEvent,
} from "../src/canonical-loop/index.js";
import { readOpMessages } from "../src/canonical-loop/store.js";
import { readOp, newOpId } from "../src/workers/op-store.js";
import type { Op } from "../src/workers/types.js";
import { trackOpForSession } from "../src/workers/session-bridge.js";
import {
  pushInject,
  hasInjects,
  _resetInjectQueues,
} from "../src/agent-loop/inject-queue.js";

import { FakeAdapter, scriptMultiTurn, scriptTurn } from "./canonical-loop/fake-adapter.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];
const track = <T extends string>(id: T): T => { tracked.push(id); return id; };

beforeEach(() => {
  process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
  _resetInjectQueues();
});

afterEach(async () => {
  await awaitIdle(3_000).catch(() => undefined);
  resetScheduler();
  resetCanonicalRuntime();
  resetBus();
  _resetInjectQueues();
  for (const id of tracked) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  tracked.length = 0;
  delete process.env.LAX_CANONICAL_LOOP_INTERACTIVE;
});

function mkOp(label: string, type: string = "chat_turn"): Op {
  return {
    id: track(newOpId(`it12_${label}`)),
    type,
    task: `issue-12 ${label}`,
    contextPack: {} as Op["contextPack"],
    lane: "interactive",
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test-issue-12",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

async function awaitTerminal(opId: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const op = readOp(opId);
    const s = op?.canonical?.state;
    if (s === "succeeded" || s === "failed" || s === "cancelled") return;
    if (Date.now() > deadline) {
      throw new Error(`awaitTerminal timed out for ${opId} — state=${s}`);
    }
    await new Promise(r => setTimeout(r, 5));
  }
}

function bodyOf<T = Record<string, unknown>>(e: CanonicalEvent): T {
  return (e.body ?? {}) as T;
}

// ── Happy path ───────────────────────────────────────────────────────────

describe("Issue 12 — inject drained at next turn (chat_turn op)", () => {
  it("a pushInject during turn 0 surfaces as a user message on turn 1", async () => {
    const sessionId = "sess-inject-happy";
    const op = mkOp("happy");
    trackOpForSession(op.id, sessionId);

    // Two-turn adapter: turn 0 streams (gives us a window for the inject),
    // turn 1 terminates. No tools — keeps the test focused on the drain.
    const adapter = new FakeAdapter({
      script: scriptMultiTurn([
        { streamChunks: ["s0", "s1"], text: "turn 0 reply" },
        { text: "turn 1 reply (after inject)", terminal: "done" },
      ]),
    });
    registerAdapterForOp(op.id, () => adapter);

    // Push the inject during turn 0's STREAM — by then turn 0's drain has
    // already run, so the inject lands in turn 1's drain. This is the real
    // semantic: user types while the agent is mid-response, agent sees the
    // message at the next turn boundary.
    let injected = false;
    const offStream = subscribeOpStream(op.id, () => {
      if (!injected) {
        injected = true;
        pushInject(sessionId, "actually use blue not red");
      }
    });

    canonicalLoopEntry(op);
    await awaitTerminal(op.id);
    offStream();

    // Adapter saw two turns; turn 1's messages include the inject as a
    // user-role row. Find it by content text — the seed produces no text
    // rows in this test (no chat-runner pre-seed), so the inject is the
    // only user message at turnIdx=1.
    // turn-loop wraps the inject body with a temporal-context marker so
    // the model knows this message arrived mid-turn. Assert the wrapped
    // form here (and that the user's text is preserved verbatim inside).
    const expectedText = "[mid-turn user message] actually use blue not red";
    expect(adapter.turnInputs).toHaveLength(2);
    const turn1Messages = adapter.turnInputs[1].messages;
    const injectRow = turn1Messages.find(
      m => m.role === "user" &&
        m.turnIdx === 1 &&
        typeof (m.content as { text?: unknown })?.text === "string" &&
        (m.content as { text: string }).text === expectedText,
    );
    expect(injectRow, "inject must appear as a user message on turn 1").toBeDefined();

    // The inject lives in op_messages too, at turnIdx=1, role=user.
    const persisted = readOpMessages(op.id).filter(
      m => m.turnIdx === 1 && m.role === "user" &&
        (m.content as { text?: string })?.text === expectedText,
    );
    expect(persisted).toHaveLength(1);

    // A message_appended event was emitted for the inject (turn 1, user).
    const events = readCanonicalEvents(op.id);
    const appendedUserOnTurn1 = events.filter(
      e => e.type === "message_appended" &&
        bodyOf<{ turnIdx: number; role: string }>(e).turnIdx === 1 &&
        bodyOf<{ turnIdx: number; role: string }>(e).role === "user",
    );
    expect(appendedUserOnTurn1.length).toBeGreaterThanOrEqual(1);

    // Queue drained.
    expect(hasInjects(sessionId)).toBe(false);
  });
});

// ── Multiple injects in one window ───────────────────────────────────────

describe("Issue 12 — multiple injects coalesce on the next turn in order", () => {
  it("two pushInjects during turn 0 land as two user rows on turn 1, in submission order", async () => {
    const sessionId = "sess-inject-multi";
    const op = mkOp("multi");
    trackOpForSession(op.id, sessionId);

    const adapter = new FakeAdapter({
      script: scriptMultiTurn([
        { streamChunks: ["a"], text: "turn 0" },
        { text: "turn 1", terminal: "done" },
      ]),
    });
    registerAdapterForOp(op.id, () => adapter);

    let injected = false;
    const offStream = subscribeOpStream(op.id, () => {
      if (!injected) {
        injected = true;
        pushInject(sessionId, "first thought");
        pushInject(sessionId, "second thought");
      }
    });

    canonicalLoopEntry(op);
    await awaitTerminal(op.id);
    offStream();

    const first = "[mid-turn user message] first thought";
    const second = "[mid-turn user message] second thought";
    const persisted = readOpMessages(op.id).filter(
      m => m.turnIdx === 1 && m.role === "user" &&
        ((m.content as { text?: string })?.text === first ||
         (m.content as { text?: string })?.text === second),
    );
    expect(persisted).toHaveLength(2);
    // Order preserved.
    expect((persisted[0].content as { text: string }).text).toBe(first);
    expect((persisted[1].content as { text: string }).text).toBe(second);
    // Contiguous seqInTurn (offset past any turn-1 prefix; injects sit
    // adjacent in the order pushed).
    expect(persisted[1].seqInTurn).toBe(persisted[0].seqInTurn + 1);
  });
});

// ── Gating on op type ────────────────────────────────────────────────────

describe("Issue 12 — non-chat_turn ops do NOT drain the queue", () => {
  it("a freeform op for a session with pending injects leaves the queue intact", async () => {
    const sessionId = "sess-no-drain";
    pushInject(sessionId, "should-survive");

    const op = mkOp("freeform-no-drain", "freeform");
    trackOpForSession(op.id, sessionId);

    const adapter = new FakeAdapter({
      script: [scriptTurn({ text: "freeform done", terminal: "done" })],
    });
    registerAdapterForOp(op.id, () => adapter);

    canonicalLoopEntry(op);
    await awaitTerminal(op.id);

    // Inject is still in the queue — freeform op did not consume it.
    expect(hasInjects(sessionId)).toBe(true);
    // The inject text never reached op_messages. (Freeform ops still get a
    // seedInitialUserMessage row from `op.task`; we're asserting the
    // inject specifically wasn't drained.)
    const injectRows = readOpMessages(op.id).filter(
      m => m.role === "user" && (m.content as { text?: string })?.text === "should-survive",
    );
    expect(injectRows).toHaveLength(0);
  });
});

// ── No-op when queue empty ───────────────────────────────────────────────

describe("Issue 12 — empty queue is a clean no-op", () => {
  it("chat_turn op with no pending injects produces no extra rows or events", async () => {
    const sessionId = "sess-empty";
    const op = mkOp("empty");
    trackOpForSession(op.id, sessionId);

    const adapter = new FakeAdapter({
      script: [scriptTurn({ text: "single turn", terminal: "done" })],
    });
    registerAdapterForOp(op.id, () => adapter);

    canonicalLoopEntry(op);
    await awaitTerminal(op.id);

    // No user rows from the drain (the adapter doesn't produce user rows
    // either — those only come from seedInitialUserMessage in real chat).
    const userRows = readOpMessages(op.id).filter(m => m.role === "user");
    // seedInitialUserMessage fires in the worker for canonical bootstrap;
    // it produces a single turn-0 user row from `op.task`. The drain must
    // not add any beyond that.
    expect(userRows.every(r => r.turnIdx === 0 && r.seqInTurn === 0)).toBe(true);
  });
});

// ── Resume-gate: end_turn with pending inject keeps the worker looping ──
//
// Real failure (session chat-mox9veaj-i2zwt, 2026-05-08): a 298-action turn
// ended with terminalReason=done while a user inject was still queued. The
// worker's loop broke on terminal, the chat ended, and the inject was
// stranded — the agent never saw it. Fix in src/canonical-loop/worker.ts:
// if op.type==="chat_turn" and the inject queue is non-empty when the
// adapter signals done, override the break and let the worker loop one
// more turn so driveTurn drains the queue at the top.

describe("Issue 12 — terminal end_turn with pending inject extends the worker loop", () => {
  it("end_turn on turn 0 + mid-turn inject → worker runs turn 1 and adapter sees the inject", async () => {
    const sessionId = "sess-inject-resume-gate";
    const op = mkOp("resume-gate");
    trackOpForSession(op.id, sessionId);

    // Adapter scripts TWO turns, both ending in done. Turn 0 streams a few
    // chunks (gives us a window to inject AFTER drain has already happened
    // for this turn) then ends with done. Without the resume-gate fix the
    // worker would break here and turn 1 would never run; with the fix,
    // turn 0's done is overridden because hasInjects() is true, the worker
    // iterates, and turn 1 sees the inject on its drain.
    const adapter = new FakeAdapter({
      script: scriptMultiTurn([
        { streamChunks: ["s0", "s1"], text: "turn 0 reply", terminal: "done" },
        { text: "turn 1 reply seeing inject", terminal: "done" },
      ]),
    });
    registerAdapterForOp(op.id, () => adapter);

    // Push the inject DURING turn 0's stream — after turn 0's drain has
    // already run, so the inject sits in the queue when turn 0 ends with
    // done. That's the resume-gate trigger.
    let injected = false;
    const offStream = subscribeOpStream(op.id, () => {
      if (!injected) {
        injected = true;
        pushInject(sessionId, "actually skip the pink cup line — never added");
      }
    });

    canonicalLoopEntry(op);
    await awaitTerminal(op.id);
    offStream();

    // The worker must have driven TWO turns despite turn 0 returning done,
    // because the resume-gate kept it looping for the queued inject.
    expect(adapter.turnInputs).toHaveLength(2);

    // Turn 1's input contains the inject as a user message, wrapped with
    // the temporal-context marker so the model knows it arrived mid-turn.
    const expected = "[mid-turn user message] actually skip the pink cup line — never added";
    const turn1Messages = adapter.turnInputs[1].messages;
    const injectRow = turn1Messages.find(
      m => m.role === "user" &&
        m.turnIdx === 1 &&
        typeof (m.content as { text?: unknown })?.text === "string" &&
        (m.content as { text: string }).text === expected,
    );
    expect(injectRow, "inject must surface as a user message on turn 1").toBeDefined();

    // Queue is drained.
    expect(hasInjects(sessionId)).toBe(false);
  });

  it("the chat-history strip-marker pulls the user-visible text back out of the wrapped form", () => {
    // routes/chat.ts strips the engine marker for session.messages so the
    // chat UI shows what the user actually typed, not the framing the
    // model sees. Pin the regex contract here.
    const wrapped = "[mid-turn user message] actually skip that line";
    const stripped = wrapped.replace(/^\[mid-turn user message\]\s*/, "");
    expect(stripped).toBe("actually skip that line");

    // Idempotent: stripping a non-wrapped string is a no-op.
    const plain = "hello there";
    expect(plain.replace(/^\[mid-turn user message\]\s*/, "")).toBe(plain);
  });

  it("end_turn with empty queue terminates immediately (no spurious extra turn)", async () => {
    const sessionId = "sess-inject-no-extend";
    const op = mkOp("no-extend");
    trackOpForSession(op.id, sessionId);

    // Adapter scripts ONE turn that signals done. With NO inject queued,
    // the resume-gate must NOT keep looping — that would re-call the
    // adapter for a turn it doesn't have a script for, surfacing as a
    // test failure. This pins the gate to firing only when injects exist.
    const adapter = new FakeAdapter({
      script: [scriptTurn({ text: "clean done", terminal: "done" })],
    });
    registerAdapterForOp(op.id, () => adapter);

    canonicalLoopEntry(op);
    await awaitTerminal(op.id);

    expect(adapter.turnInputs).toHaveLength(1);
  });
});
