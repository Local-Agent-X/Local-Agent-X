/**
 * Regression coverage for the CT-3/CT-4/CT-5/CT-7 chat-ws fixes.
 *
 *  CT-3  subscribe-replay must NOT duplicate streamed text — it first wipes
 *        the stale lane, then replays ordered run deltas so a mid-turn
 *        re-subscribe rebuilds both exact text and timeline boundaries.
 *  CT-4  a Stop that races the turn's prep window (ActiveChat not registered
 *        yet) must terminate the turn the instant it registers — but must be
 *        DISCARDED if that turn dies before registering, so it can never
 *        abort the user's next legitimate turn on the same session.
 *  CT-5  terminateChat must buffer its own terminal `done` and schedule the
 *        sweep — otherwise a stopped-then-abandoned session leaks its buffer
 *        and a later reload replays a phantom streaming bubble.
 *  CT-7  a valid-JSON non-object frame (`null`) must not crash the router.
 *  C3.1  an inject that lands in a turn's salvage window must QUEUE, not be
 *        promoted to a takeover turn that kills the turn still on screen —
 *        and must still be ACKED and eventually ANSWERED: a fresh-turn route
 *        acks with inject_consumed (the client's only un-dim signal), and a
 *        queue nobody drained is promoted when the lock releases.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { WebSocket } from "ws";
import type { ServerEvent } from "../types.js";
import { attachMessageRouter } from "./message-router.js";
import {
  activeChats,
  clients,
  terminateChat,
  broadcastActiveChats,
  setChatHandler,
  type ChatHandler,
} from "./state.js";
import { replayBufferedEvents } from "./replay.js";
import { markChatHandlerPending, clearChatHandlerPending, listOpsForSession, hasChatHandlerPending } from "../ops/session-bridge.js";
import { getTurnRegistry, releaseTurn } from "../session/turn-lock.js";
import { drainInjects, hasInjects, _resetInjectQueues } from "../agent-loop/inject-queue.js";

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
    streamText, sawStream: streamText !== "", reasoningText: "", sawReasoning: false, toolsSinceText: false,
    runs: streamText ? [{ lane: "stream" as const, text: streamText }] : [], runBoundary: false,
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

describe("CT-3 — subscribe replay wipes then rebuilds ordered runs", () => {
  it("replays the streamText accumulator as a corrective wipe followed by its run delta", async () => {
    const sessionId = "sess-ct3";
    registerChat(sessionId, [], "Hello world");
    const r = makeRouter();
    await r.dispatch({ type: "subscribe", sessionId });

    const streamFrames = r.frames()
      .filter(f => f.type === "event" && f.event?.type === "stream")
      .map(f => f.event);
    // The empty replace clears any partial already held by a reconnecting
    // client; ordered deltas then rebuild the canonical run timeline without
    // duplicating text. The manager tests pin multi-run boundary ordering.
    expect(streamFrames).toHaveLength(2);
    expect(streamFrames[0]).toMatchObject({ type: "stream", replace: true, text: "" });
    expect(streamFrames[1]).toMatchObject({ type: "stream", delta: "Hello world" });
    expect(streamFrames[1].replace).toBeUndefined();
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
    const wipeIdx = events.findIndex(e => e.type === "stream" && e.replace === true && e.text === "");
    const streamIdx = events.findIndex(e => e.type === "stream" && e.delta === "abc");
    const doneIdx = events.findIndex(e => e.type === "done");
    expect(wipeIdx).toBeGreaterThanOrEqual(0);
    expect(streamIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThanOrEqual(0);
    // Corrective wipe, then rebuilt text, then the terminal: a trailing
    // error/done cannot erase the replayed run or leave a phantom stream.
    expect(wipeIdx).toBeLessThan(streamIdx);
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
      streamText: "", sawStream: false, reasoningText: "", sawReasoning: false, toolsSinceText: false,
      runs: [], runBoundary: false,
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

describe("C3.1 — inject routing consults the turn lock", () => {
  const sessionId = "sess-c31";
  const registry = getTurnRegistry();
  const started: Array<{ sessionId: string; message: string }> = [];
  // setChatHandler takes a ChatHandler, not null, so the teardown restores an
  // inert one rather than the module's initial null. Nothing else in this file
  // dispatches `chat`/`inject`, so an inert handler is invisible to them.
  const inertHandler: ChatHandler = () => {};

  beforeEach(() => {
    started.length = 0;
    setChatHandler((sid, message) => { started.push({ sessionId: sid, message }); });
  });

  afterEach(() => {
    // Queues first: releaseTurn fires the promote-on-release hook, and an
    // empty queue makes that deferred pass a guaranteed no-op so it can't
    // start a turn into the next test.
    _resetInjectQueues();
    releaseTurn(sessionId);
    setChatHandler(inertHandler);
  });

  /** A router whose socket is also a subscriber, so broadcastToSession lands. */
  function subscribedRouter() {
    const r = makeRouter();
    clients.set(r.ws, new Set([sessionId]));
    return r;
  }

  /** Let one macrotask run — the promote-on-release pass defers by exactly
   *  that much so a replacement turn's acquire (a microtask off the released
   *  turn's completion promise) gets to land first. */
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));

  it("queues an inject that lands in the salvage window instead of starting a second turn", async () => {
    // The salvage window: the op already hit terminal so releaseOpFromSession
    // emptied sessionOps, and this turn was never marked pending (only
    // lifecycle.ts's WS path marks it — HTTP/SSE, voice and cron turns never
    // do). Both ops-layer signals therefore read idle while the turn lock is
    // still held by the handler working through its persist and the browser is
    // still streaming the answer.
    expect(listOpsForSession(sessionId)).toEqual([]);
    expect(hasChatHandlerPending(sessionId)).toBe(false);
    expect(registry.acquireTurn(sessionId, new AbortController(), "salvaging")).toBe(true);

    const r = subscribedRouter();
    await r.dispatch({ type: "inject", sessionId, message: "make it blue", injectId: "inj-c31" });

    // Pre-fix: the fresh-turn branch fired, so a second chat turn started —
    // and its tryAcquireOrReplace aborted the turn still painting on screen,
    // leaving the dead turn's partial next to the new turn's re-answer.
    expect(started).toEqual([]);
    expect(drainInjects(sessionId).map(i => i.text)).toEqual(["make it blue"]);

    const events = r.frames().filter(f => f.type === "event").map(f => f.event);
    // Pre-fix the client was told the running turn had absorbed the inject —
    // the exact opposite of what happened to that turn.
    expect(events.some(e => e.type === "inject_consumed")).toBe(false);
    expect(events).toContainEqual({ type: "inject_queued", injectId: "inj-c31" });
  });

  it("still opens a fresh turn when the lock is free too — and ACKS it so the echo un-dims", async () => {
    // Genuinely idle session: no ops, no pending handler, no turn lock. The
    // message BECOMES the turn — but it arrived on the inject lane, so the
    // client's local echo carries _queueState:'queued' (chat-send.js) and
    // inject_consumed is the ONLY event that clears it (chat-ws-handler.js
    // handleInjectConsumed — inject_queued is informational and clears
    // nothing). Ack-less, splitQueuedInjects re-emits that echo BELOW the
    // answer as a dimmed, forever-pulsing "still waiting" row for a message
    // that was answered, and app-sync skips hydrate for the active chat so a
    // reload doesn't clear it either.
    const r = subscribedRouter();
    await r.dispatch({ type: "inject", sessionId, message: "start fresh", injectId: "inj-c31b" });

    expect(started).toEqual([{ sessionId, message: "start fresh" }]);
    expect(drainInjects(sessionId)).toEqual([]);
    const events = r.frames().filter(f => f.type === "event").map(f => f.event);
    expect(events).toContainEqual({ type: "inject_consumed", injectId: "inj-c31b" });
  });

  it("promotes an inject the ended turn never drained, once the lock releases", async () => {
    // A queued inject has exactly ONE drainer: drainInjectsIntoTurn at the
    // top of a turn iteration. One that lands after the turn's last drain
    // gate has nobody left to read it, so queuing alone left it sitting until
    // the user's NEXT message — indistinguishable from a dropped message.
    expect(registry.acquireTurn(sessionId, new AbortController(), "salvaging")).toBe(true);
    const r = subscribedRouter();
    await r.dispatch({ type: "inject", sessionId, message: "and make it blue", injectId: "inj-c31c" });
    expect(started).toEqual([]);
    expect(hasInjects(sessionId)).toBe(true);

    releaseTurn(sessionId);
    await tick();

    expect(started).toEqual([{ sessionId, message: "and make it blue" }]);
    expect(hasInjects(sessionId)).toBe(false);
    const events = r.frames().filter(f => f.type === "event").map(f => f.event);
    expect(events).toContainEqual({ type: "inject_consumed", injectId: "inj-c31c" });
  });

  it("stands down when a replacement turn took the lock — that turn drains it", async () => {
    expect(registry.acquireTurn(sessionId, new AbortController(), "first")).toBe(true);
    const r = subscribedRouter();
    await r.dispatch({ type: "inject", sessionId, message: "wait for me", injectId: "inj-c31d" });

    // tryAcquireOrReplace's shape: the prior turn releases and the waiter —
    // resumed on a microtask off that turn's completion promise, so ahead of
    // the deferred promote — acquires the slot.
    releaseTurn(sessionId);
    expect(registry.acquireTurn(sessionId, new AbortController(), "replacement")).toBe(true);
    await tick();

    // Promoting here would run a SECOND turn alongside the replacement — the
    // takeover this branch exists to prevent. Leave it queued; the
    // replacement's first-iteration drainInjectsIntoTurn takes it.
    expect(started).toEqual([]);
    expect(drainInjects(sessionId).map(i => i.text)).toEqual(["wait for me"]);
  });
});

describe("CT-8 — a chat re-send during a live turn is absorbed as an inject", () => {
  const sessionId = "sess-ct8";
  const registry = getTurnRegistry();
  const started: Array<{ sessionId: string; message: string }> = [];
  const inertHandler: ChatHandler = () => {};

  beforeEach(() => {
    started.length = 0;
    setChatHandler((sid, message) => { started.push({ sessionId: sid, message }); });
  });

  afterEach(() => {
    // Queues first: releaseTurn fires promote-on-release, and an empty queue
    // makes that deferred pass a guaranteed no-op (can't start a turn into the
    // next test).
    _resetInjectQueues();
    releaseTurn(sessionId);
    setChatHandler(inertHandler);
  });

  function subscribedRouter() {
    const r = makeRouter();
    clients.set(r.ws, new Set([sessionId]));
    return r;
  }

  it("queues the re-send instead of starting/replacing the live turn", async () => {
    // A turn holds the session (the app looks hung to the user while a long
    // tool loop runs). Pre-fix a `chat` frame here went to startChat →
    // tryAcquireOrReplace, which ABORTED the live turn (duplicate bubble) or
    // refused with "previous request still running." It must instead be
    // absorbed onto the running turn via the inject lane.
    const live = new AbortController();
    expect(registry.acquireTurn(sessionId, live, "long-turn")).toBe(true);

    const r = subscribedRouter();
    await r.dispatch({ type: "chat", sessionId, message: "also make it dark mode" });

    // Not started as a new/replacement turn, and the live turn was NOT aborted.
    expect(started).toEqual([]);
    expect(live.signal.aborted).toBe(false);
    // It landed in the inject queue — the running turn's next drain takes it.
    expect(drainInjects(sessionId).map(i => i.text)).toEqual(["also make it dark mode"]);
    const events = r.frames().filter(f => f.type === "event").map(f => f.event);
    expect(events.some(e => e.type === "inject_queued")).toBe(true);
  });

  it("still starts a normal new turn when nothing is live (unchanged)", async () => {
    // No turn lock held → behavior is exactly as before: the chat handler runs.
    const r = subscribedRouter();
    await r.dispatch({ type: "chat", sessionId, message: "hello there" });

    expect(started).toEqual([{ sessionId, message: "hello there" }]);
    expect(drainInjects(sessionId)).toEqual([]);
  });

  it("does NOT absorb a re-send that carries an attachment (no silent drop)", async () => {
    // Injects carry no attachments, so an image-bearing re-send must take the
    // normal path rather than have its attachment silently dropped.
    const live = new AbortController();
    expect(registry.acquireTurn(sessionId, live, "long-turn")).toBe(true);

    const r = subscribedRouter();
    await r.dispatch({
      type: "chat",
      sessionId,
      message: "and this screenshot",
      attachments: [{ isImage: true, dataUrl: "data:image/png;base64,AAAA" }],
    });

    // Routed to the chat handler (normal path), NOT queued as a text-only inject.
    expect(started).toEqual([{ sessionId, message: "and this screenshot" }]);
    expect(hasInjects(sessionId)).toBe(false);
  });

  it("dedupes an identical re-send to a no-op ack, not a second queued message", async () => {
    // The core anti-duplicate guarantee: a literal double-send of the same text
    // during a live turn queues ONCE and is answered once. The second send is a
    // no-op acked with inject_consumed (the client's un-dim signal), not a
    // second queue entry that the turn would answer twice.
    const live = new AbortController();
    expect(registry.acquireTurn(sessionId, live, "long-turn")).toBe(true);

    const r = subscribedRouter();
    await r.dispatch({ type: "chat", sessionId, message: "run the tests" });
    await r.dispatch({ type: "chat", sessionId, message: "run the tests" });

    expect(started).toEqual([]);
    expect(live.signal.aborted).toBe(false);
    // Queued exactly once.
    expect(drainInjects(sessionId).map(i => i.text)).toEqual(["run the tests"]);
    const events = r.frames().filter(f => f.type === "event").map(f => f.event);
    expect(events.some(e => e.type === "inject_queued")).toBe(true);
    // The duplicate got a consumed ack rather than a second inject_queued.
    expect(events.some(e => e.type === "inject_consumed")).toBe(true);
    expect(events.filter(e => e.type === "inject_queued")).toHaveLength(1);
  });
});
