/**
 * Regression coverage for the CT-3/CT-4/CT-5/CT-7 chat-ws fixes.
 *
 *  CT-3  subscribe-replay must NOT duplicate streamed text — buffered deltas
 *        are coalesced into a single `replace` so a mid-turn re-subscribe
 *        can't append the whole partial onto the partial the client holds.
 *  CT-4  a Stop that races the turn's prep window (ActiveChat not registered
 *        yet) must terminate the turn the instant it registers — but must be
 *        DISCARDED if that turn dies before registering, so it can never
 *        abort the user's next legitimate turn on the same session.
 *  CT-5  terminateChat must buffer its own terminal `done` and schedule the
 *        sweep — otherwise a stopped-then-abandoned session leaks its buffer
 *        and a later reload replays a phantom streaming bubble.
 *  CT-7  a valid-JSON non-object frame (`null`) must not crash the router.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WebSocket } from "ws";
import type { ServerEvent } from "../types.js";
import { attachMessageRouter } from "./message-router.js";
import {
  activeChats,
  clients,
  terminateChat,
  replayBufferedEvents,
  broadcastActiveChats,
} from "./state.js";
import { markChatHandlerPending, clearChatHandlerPending } from "../ops/session-bridge.js";

function makeRouter() {
  const sent: string[] = [];
  let onMessage: ((data: Buffer) => unknown) | null = null;
  const ws = {
    readyState: 1,
    send: (p: string) => { sent.push(p); },
    on: (evt: string, cb: (data: Buffer) => unknown) => { if (evt === "message") onMessage = cb; },
  } as unknown as WebSocket;
  const subscriptions = new Set<string>();
  attachMessageRouter({ ws, subscriptions });
  return {
    ws,
    sent,
    subscriptions,
    dispatch: (obj: unknown) => onMessage!(Buffer.from(JSON.stringify(obj))),
    raw: (s: string) => onMessage!(Buffer.from(s)),
    frames: () => sent.map(p => JSON.parse(p)),
  };
}

/** Register an ActiveChat the way manager.startChat does (set + broadcast).
 *  Stream text is seeded via `streamText` (the accumulator manager.onEvent
 *  maintains) — stream events never enter `events` post-2026-07-13. */
function registerChat(sessionId: string, events: ServerEvent[] = [], streamText = ""): AbortController {
  const abortController = new AbortController();
  activeChats.set(sessionId, {
    sessionId, events: [...events], abortController, startedAt: Date.now(), done: false,
    streamText, sawStream: streamText !== "", toolsSinceText: false,
  });
  broadcastActiveChats();
  return abortController;
}

beforeEach(() => {
  activeChats.clear();
  clients.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CT-7 — non-object frame guard", () => {
  it("a bare `null` frame does not crash the router", async () => {
    const r = makeRouter();
    // Pre-fix: `msg.type` on a parsed `null` threw TypeError → the async
    // handler rejected. The guard makes it a clean no-op.
    await expect(Promise.resolve(r.raw("null"))).resolves.toBeUndefined();
    await expect(Promise.resolve(r.raw("42"))).resolves.toBeUndefined();
    await expect(Promise.resolve(r.raw("[1,2]"))).resolves.toBeUndefined();
  });

  it("still dispatches a normal object frame (ping → pong)", async () => {
    const r = makeRouter();
    await r.dispatch({ type: "ping" });
    expect(r.frames().some(f => f.type === "pong")).toBe(true);
  });
});

describe("CT-3 — subscribe replay sends accumulated text as one replace", () => {
  it("replays the streamText accumulator as a single `replace`, never raw deltas", async () => {
    const sessionId = "sess-ct3";
    registerChat(sessionId, [], "Hello world");
    const r = makeRouter();
    await r.dispatch({ type: "subscribe", sessionId });

    const streamFrames = r.frames()
      .filter(f => f.type === "event" && f.event?.type === "stream")
      .map(f => f.event);
    // Exactly one coalesced replace — pre-fix replayed both deltas raw, and
    // the client's `content += delta` doubled the partial it already held.
    expect(streamFrames).toHaveLength(1);
    expect(streamFrames[0]).toMatchObject({ type: "stream", replace: true, text: "Hello world" });
    expect(streamFrames.some(e => typeof e.delta === "string")).toBe(false);
  });
});

describe("CT-5 — terminateChat buffers the terminal + sweeps", () => {
  it("buffers error+done into the replay buffer and marks done", () => {
    const sessionId = "sess-ct5";
    registerChat(sessionId, [], "hi");

    expect(terminateChat(sessionId, { abort: true, errorMessage: "Stopped by user" })).toBe(true);

    const chat = activeChats.get(sessionId)!;
    expect(chat.done).toBe(true);
    const types = chat.events.map(e => e.type);
    // Pre-fix: only ["stream"] — the terminal was broadcast but never buffered.
    expect(types).toContain("error");
    expect(types[types.length - 1]).toBe("done");
  });

  it("a post-stop replay ends in a terminal `done` (no phantom streaming)", () => {
    const sessionId = "sess-ct5b";
    registerChat(sessionId, [], "abc");
    terminateChat(sessionId, { abort: false, errorMessage: "" });

    const sent: string[] = [];
    const ws = { readyState: 1, send: (p: string) => sent.push(p) } as unknown as WebSocket;
    replayBufferedEvents(ws, sessionId);

    const events = sent.map(p => JSON.parse(p).event);
    const streamIdx = events.findIndex(e => e.type === "stream" && e.replace === true && e.text === "abc");
    const doneIdx = events.findIndex(e => e.type === "done");
    expect(streamIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThanOrEqual(0);
    // Coalesced text before the terminal so a trailing error/done can't wipe it.
    expect(streamIdx).toBeLessThan(doneIdx);
  });

  it("sweeps the stopped chat's buffer after the linger window", () => {
    vi.useFakeTimers();
    const sessionId = "sess-ct5c";
    registerChat(sessionId, [], "x");
    terminateChat(sessionId, { abort: true, errorMessage: "Stopped by user" });
    expect(activeChats.has(sessionId)).toBe(true);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    // Pre-fix: the entry (and its up-to-500-event buffer) leaked forever.
    expect(activeChats.has(sessionId)).toBe(false);
  });
});

describe("CT-4 — stop during the prep window", () => {
  it("terminates the turn the instant its ActiveChat registers, even after prep delay", () => {
    vi.useFakeTimers();
    const sessionId = "sess-ct4";
    markChatHandlerPending(sessionId); // handler is mid-prep, no ActiveChat yet
    try {
      // Stop races registration — nothing live to abort yet, so it must be
      // deferred (pre-fix: silent no-op, return value discarded, turn ran on
      // while the client painted [stopped]).
      expect(terminateChat(sessionId, { abort: true, errorMessage: "Stopped by user" })).toBe(false);

      // Prep takes a while; the pending flag stays up the whole time, so the
      // deferred stop must survive (kills any naive time-based discard).
      vi.advanceTimersByTime(200);

      // The turn now registers its ActiveChat (mirrors manager.startChat,
      // which fires broadcastActiveChats right after activeChats.set).
      const abort = registerChat(sessionId);

      expect(abort.signal.aborted).toBe(true);
      expect(activeChats.get(sessionId)!.done).toBe(true);
    } finally {
      clearChatHandlerPending(sessionId);
    }
  });

  it("discards the deferred stop when the prep turn dies before registering (retry is NOT killed)", () => {
    // Skeptic's scenario: prep turn hits an early exit (missing credential,
    // worker redirect, prepare throw) and ends WITHOUT registering an
    // ActiveChat. lifecycle's finally clears the pending flag; the deferred
    // stop must be discarded, not drained onto the next legitimate turn.
    vi.useFakeTimers();
    const sessionId = "sess-ct4-dead-prep";
    markChatHandlerPending(sessionId);
    expect(terminateChat(sessionId, { abort: true, errorMessage: "Stopped by user" })).toBe(false);

    // Prep turn dies on its early exit — pending cleared, nothing registered.
    clearChatHandlerPending(sessionId);
    vi.advanceTimersByTime(100); // let the pending-stop poll observe the drop

    // Well within any TTL window, the user re-auths and resends.
    markChatHandlerPending(sessionId);
    try {
      const abort = registerChat(sessionId);
      // Pre-fix (TTL-only cleanup): the stale stop drained here and aborted
      // the fresh turn with "Stopped by user".
      expect(abort.signal.aborted).toBe(false);
      expect(activeChats.get(sessionId)!.done).toBe(false);
    } finally {
      clearChatHandlerPending(sessionId);
    }
  });

  it("a lingering done entry from the previous turn does not eat the deferred stop", () => {
    const sessionId = "sess-ct4-linger";
    // Previous turn finished; its entry lingers (5-min replay window).
    activeChats.set(sessionId, {
      sessionId, events: [], abortController: new AbortController(), startedAt: Date.now(), done: true,
      streamText: "", sawStream: false, toolsSinceText: false,
    });
    markChatHandlerPending(sessionId); // new turn mid-prep
    try {
      expect(terminateChat(sessionId, { abort: true, errorMessage: "Stopped by user" })).toBe(false);

      // Any unrelated broadcast fires while the new turn is still mid-prep —
      // the drain must NOT consume the stop against the done entry.
      broadcastActiveChats();

      const abort = registerChat(sessionId); // new turn registers (overwrites)
      expect(abort.signal.aborted).toBe(true);
      expect(activeChats.get(sessionId)!.done).toBe(true);
    } finally {
      clearChatHandlerPending(sessionId);
    }
  });

  it("does NOT defer a transport-level failChat (abort:false) — only user stops defer", () => {
    // Orchestrator/lifecycle error paths call failChat while the pending flag
    // is still up (catch runs before finally). Deferring that terminal would
    // let a dying turn's failChat kill a concurrent second turn (double-send)
    // on the same session. With nothing registered, dropping is correct.
    const sessionId = "sess-ct4-failchat";
    markChatHandlerPending(sessionId); // e.g. the concurrent turn still mid-prep
    try {
      expect(terminateChat(sessionId, { abort: false, errorMessage: "Chat ended unexpectedly." })).toBe(false);

      const abort = registerChat(sessionId);
      expect(abort.signal.aborted).toBe(false);
      expect(activeChats.get(sessionId)!.done).toBe(false);
    } finally {
      clearChatHandlerPending(sessionId);
    }
  });

  it("does NOT poison a later message on an idle session (no pending handler)", () => {
    const sessionId = "sess-ct4-idle";
    // No markChatHandlerPending → a stop on an idle session records nothing.
    expect(terminateChat(sessionId, { abort: true, errorMessage: "Stopped by user" })).toBe(false);

    // A fresh turn registers later — it must NOT be auto-terminated.
    const abort = registerChat(sessionId);
    expect(abort.signal.aborted).toBe(false);
    expect(activeChats.get(sessionId)!.done).toBe(false);
  });
});
