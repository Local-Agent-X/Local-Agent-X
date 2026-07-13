/** Stream-accumulator replay tests (trim-truncation bug, 2026-07-13 audit).
 *
 *  onEvent used to push every per-token stream delta into chat.events and
 *  trim the buffer to the last 400 past 500 — so on any long turn a mid-turn
 *  WS reconnect replayed a `replace` built from only the TAIL, clobbering the
 *  client's fuller partial (and `done` persisted the stub). The fix folds
 *  stream text into chat.streamText on the ActiveChat and keeps stream events
 *  out of chat.events entirely; these tests pin that contract:
 *    (a) 600 deltas replay as ONE replace with the FULL concatenation
 *    (b) a replace-shaped stream event resets the accumulator
 *    (c) a tool event between deltas yields the client's "\n\n" break
 *    (d) non-stream events still replay in order, after the replace
 *    (e) terminateChat's error+done land in the replay
 *    (f) replace-to-EMPTY replays a corrective {replace, text:""} (sawStream
 *        gates the frame, not streamText truthiness)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WebSocket } from "ws";
import type { ServerEvent } from "../types.js";
import { buildManager } from "./manager.js";
import { activeChats, clients, replayBufferedEvents, terminateChat } from "./state.js";

interface Frame {
  type: string;
  sessionId?: string;
  event?: Record<string, unknown>;
  _replay?: boolean;
}

// Minimal WS double: capture everything sent, parsed. `bufferedAmount`
// models a slow/hung client for the backpressure guard tests.
function makeWs(bufferedAmount = 0): { ws: WebSocket; frames: () => Frame[] } {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    bufferedAmount,
    send: vi.fn((p: string) => { sent.push(p); }),
  } as unknown as WebSocket;
  return { ws, frames: () => sent.map(p => JSON.parse(p) as Frame) };
}

const delta = (d: string): ServerEvent => ({ type: "stream", delta: d });
const toolStart: ServerEvent = { type: "tool_start", toolName: "web_search", args: {} };
const toolEnd: ServerEvent = { type: "tool_end", toolName: "web_search", result: "ok", allowed: true };

beforeEach(() => {
  activeChats.clear();
  clients.clear();
});

describe("stream accumulator survives the 500/400 event trim", () => {
  it("(a) 600 deltas replay as ONE replace containing the full concatenation", () => {
    const m = buildManager();
    const { onEvent } = m.startChat("s-long");
    let full = "";
    for (let i = 0; i < 600; i++) {
      const d = `t${i} `;
      full += d;
      onEvent(delta(d));
    }
    // Structural half of the fix: stream events never enter the buffer, so
    // the trim has nothing to truncate.
    expect(activeChats.get("s-long")!.events).toHaveLength(0);

    const { ws, frames } = makeWs();
    replayBufferedEvents(ws, "s-long");
    const streamFrames = frames().filter(f => f.event?.type === "stream");
    expect(streamFrames).toHaveLength(1);
    expect(streamFrames[0].event).toMatchObject({ replace: true, text: full });
    expect(streamFrames[0]._replay).toBe(true);
  });

  it("(b) a replace-shaped stream event resets the accumulator", () => {
    const m = buildManager();
    const { onEvent } = m.startChat("s-replace");
    onEvent(delta("draft one"));
    // Adapter-initiated replacement (tool-call-from-text extraction).
    onEvent({ type: "stream", replace: true, text: "clean" } as ServerEvent);
    onEvent(delta(" tail"));

    const { ws, frames } = makeWs();
    replayBufferedEvents(ws, "s-replace");
    const streamFrames = frames().filter(f => f.event?.type === "stream");
    expect(streamFrames).toHaveLength(1);
    expect(streamFrames[0].event).toMatchObject({ replace: true, text: "clean tail" });
  });

  it("(c) a tool event between deltas produces the client's \\n\\n paragraph break", () => {
    const m = buildManager();
    const { onEvent } = m.startChat("s-tools");
    onEvent(delta("Searching now."));
    onEvent(toolStart);
    onEvent(toolEnd);
    onEvent(delta("Found it."));

    // Must match public/js/chat-stream-store.js applyEvent, which inserts
    // "\n\n" before the first delta after a tool card.
    expect(activeChats.get("s-tools")!.streamText).toBe("Searching now.\n\nFound it.");

    // But NOT when the text already ends with a newline (client guard).
    const { onEvent: on2 } = m.startChat("s-tools-nl");
    on2(delta("line\n"));
    on2(toolStart);
    on2(delta("next"));
    expect(activeChats.get("s-tools-nl")!.streamText).toBe("line\nnext");
  });

  it("(d) non-stream events replay in order, after the replace", () => {
    const m = buildManager();
    const { onEvent } = m.startChat("s-order");
    onEvent(delta("hello "));
    onEvent(toolStart);
    onEvent(delta("world"));
    onEvent(toolEnd);

    const { ws, frames } = makeWs();
    replayBufferedEvents(ws, "s-order");
    const types = frames().map(f => (f.event as { type: string }).type);
    expect(types).toEqual(["stream", "tool_start", "tool_end"]);
  });

  it("(e) terminateChat's error + done end up in the replay, after the replace", () => {
    const m = buildManager();
    const { onEvent } = m.startChat("s-stop");
    onEvent(delta("partial answer"));
    // abort:false = failChat's transport-terminal path; avoids the user-stop
    // side effects (turn-lock / self-edit teardown) irrelevant to buffering.
    const terminated = terminateChat("s-stop", { abort: false, errorMessage: "provider died" });
    expect(terminated).toBe(true);

    const { ws, frames } = makeWs();
    replayBufferedEvents(ws, "s-stop");
    const events = frames().map(f => f.event as { type: string; text?: string; message?: string });
    expect(events[0]).toMatchObject({ type: "stream", replace: true, text: "partial answer" });
    expect(events[1]).toMatchObject({ type: "error", message: "provider died" });
    expect(events[2]).toMatchObject({ type: "done" });
  });

  it("replace-to-EMPTY still replays exactly one corrective {replace, text:''}", () => {
    // The tool-call-from-text extractor (chat-runner/event-pump.ts) replaces
    // with "" when the model's whole visible text was tool-call JSON. A
    // client that blipped after streaming that JSON needs the empty replace
    // on replay to wipe the stale JSON — otherwise `done` persists it. So
    // the replay gate is sawStream, never streamText truthiness (skeptic
    // catch, 2026-07-13).
    const m = buildManager();
    const { onEvent } = m.startChat("s-empty-replace");
    onEvent(delta('{"tool":"web_search","args":{}}'));
    onEvent({ type: "stream", replace: true, text: "" } as ServerEvent);

    const { ws, frames } = makeWs();
    replayBufferedEvents(ws, "s-empty-replace");
    const streamFrames = frames().filter(f => f.event?.type === "stream");
    expect(streamFrames).toHaveLength(1);
    expect(streamFrames[0].event).toMatchObject({ replace: true, text: "" });
    expect(streamFrames[0]._replay).toBe(true);
  });

  it("(g) second startChat on a live session overwrites WITHOUT terminating the old turn", () => {
    // 2026-07-13 audit F8 + skeptic finding: startChat must NOT terminate a
    // live entry. The caller holds the session's turn lock (lock-then-
    // startChat invariant, orchestrator.ts:162) and terminateChat's abort
    // releases that lock by sessionId — it would kill the NEW turn; and
    // delegation-handoff.ts legitimately overlaps a live committing turn
    // whose closure must keep broadcasting. Warn-and-overwrite is the
    // contract; the identity-guarded sweeps protect the new entry.
    const m = buildManager();
    m.startChat("s-dup");
    const oldChat = activeChats.get("s-dup")!;
    expect(oldChat.done).toBe(false);

    m.startChat("s-dup");

    // Old turn untouched: not aborted, not marked done, no terminal buffered.
    expect(oldChat.abortController.signal.aborted).toBe(false);
    expect(oldChat.done).toBe(false);
    expect(oldChat.events.some(e => e.type === "done")).toBe(false);
    // The map holds the NEW live entry, not the old one.
    const newChat = activeChats.get("s-dup")!;
    expect(newChat).not.toBe(oldChat);
    expect(newChat.done).toBe(false);
  });

  it("(h) a stale natural-done sweep cannot reap a successor turn's entry", () => {
    // Identity-guard half of F8: onEvent's done-branch sweep used to delete
    // by sessionId unconditionally, so the OLD turn's 5-minute timer reaped
    // the NEW turn registered on the same session.
    vi.useFakeTimers();
    try {
      const m = buildManager();
      const { onEvent } = m.startChat("s-sweep");
      onEvent({
        type: "done",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      } as ServerEvent);
      expect(activeChats.get("s-sweep")!.done).toBe(true);

      // New turn registers on the same session before the old sweep fires
      // (old entry is done, so startChat's overwrite warning doesn't fire).
      m.startChat("s-sweep");
      const newChat = activeChats.get("s-sweep")!;
      expect(newChat.done).toBe(false);

      vi.advanceTimersByTime(5 * 60 * 1000);

      // New entry SURVIVES the old turn's sweep.
      expect(activeChats.get("s-sweep")).toBe(newChat);
    } finally {
      vi.useRealTimers();
    }
  });

  it("(i) chat_op_started replays BEFORE the replace; replace before trailing error/done", () => {
    // The client wipes per-turn scratch on a done→streaming transition
    // (chat-stream-store.js applyEvent 'chat_op_started'). Chronologically
    // op_started precedes all stream text, but it's buffered in chat.events
    // while the text is coalesced into the up-front replace — replaying it
    // AFTER the replace made the wipe destroy the just-replayed content on
    // same-tab reconnects. Pin the partition: op_started first, then the
    // replace, then the rest in order (replace still ahead of error/done so
    // they can't be wiped by it).
    const m = buildManager();
    const { onEvent } = m.startChat("s-op-order");
    onEvent({ type: "chat_op_started", opId: "op-1" } as ServerEvent);
    onEvent(delta("partial "));
    onEvent(toolStart);
    onEvent(delta("answer"));
    onEvent(toolEnd);
    terminateChat("s-op-order", { abort: false, errorMessage: "provider died" });

    const { ws, frames } = makeWs();
    replayBufferedEvents(ws, "s-op-order");
    const types = frames().map(f => (f.event as { type: string }).type);
    expect(types).toEqual(["chat_op_started", "stream", "tool_start", "tool_end", "error", "done"]);
    const streamFrame = frames().find(f => f.event?.type === "stream")!;
    expect(streamFrame.event).toMatchObject({ replace: true, text: "partial \n\nanswer" });
  });

  it("sends no stream frame when nothing was streamed (tool-only turn)", () => {
    const m = buildManager();
    const { onEvent } = m.startChat("s-notext");
    onEvent(toolStart);
    onEvent(toolEnd);

    const { ws, frames } = makeWs();
    replayBufferedEvents(ws, "s-notext");
    const types = frames().map(f => (f.event as { type: string }).type);
    expect(types).toEqual(["tool_start", "tool_end"]);
  });
});

describe("reasoning accumulator mirrors the stream lane", () => {
  // Sibling gap to the stream trim-truncation fix: `reasoning` deltas are
  // per-token (event-pump.ts), so buffering them in chat.events (a) blew the
  // 500/400 trim on any long thinking phase and EVICTED buffered tool events
  // from replays, and (b) double-counted on reconnect — the client APPENDS
  // replayed reasoning deltas onto the text it already holds. The fix folds
  // them into chat.reasoningText and replays ONE coalesced replace.
  const reasoning = (d: string): ServerEvent => ({ type: "reasoning", delta: d });

  it("(a) 600 reasoning deltas stay out of chat.events; buffered tool events survive; replay carries ONE replace with the full text", () => {
    const m = buildManager();
    const { onEvent } = m.startChat("s-think");
    // Tool events land BEFORE the thinking flood — under the old buffering
    // the 600 deltas trimmed them out of the replay window (the eviction
    // bug this fixes).
    onEvent(toolStart);
    onEvent(toolEnd);
    let full = "";
    for (let i = 0; i < 600; i++) {
      const d = `r${i} `;
      full += d;
      onEvent(reasoning(d));
    }
    const chat = activeChats.get("s-think")!;
    expect(chat.events.some(e => e.type === "reasoning")).toBe(false);
    expect(chat.events).toHaveLength(2); // just the tool pair — no trim pressure

    const { ws, frames } = makeWs();
    replayBufferedEvents(ws, "s-think");
    const reasoningFrames = frames().filter(f => f.event?.type === "reasoning");
    expect(reasoningFrames).toHaveLength(1);
    expect(reasoningFrames[0].event).toMatchObject({ replace: true, text: full });
    expect(reasoningFrames[0]._replay).toBe(true);
    // The eviction half: the tool cards still replay.
    const types = frames().map(f => (f.event as { type: string }).type);
    expect(types).toEqual(["reasoning", "tool_start", "tool_end"]);
  });

  it("(b) frame order: op_started → stream replace → reasoning replace → rest", () => {
    // op_started must precede both replaces — the client's done→streaming
    // scratch wipe (applyEvent 'chat_op_started') resets content AND
    // reasoning, and has to run before either refill. Reasoning and answer
    // text interleave live but sit on separate client lanes, so one
    // coalesced replace per lane reproduces the client state exactly.
    const m = buildManager();
    const { onEvent } = m.startChat("s-think-order");
    onEvent({ type: "chat_op_started", opId: "op-r" } as ServerEvent);
    onEvent(reasoning("let me check "));
    onEvent(delta("partial "));
    onEvent(reasoning("the docs"));
    onEvent(toolStart);
    onEvent(delta("answer"));
    onEvent(toolEnd);
    terminateChat("s-think-order", { abort: false, errorMessage: "provider died" });

    const { ws, frames } = makeWs();
    replayBufferedEvents(ws, "s-think-order");
    const types = frames().map(f => (f.event as { type: string }).type);
    expect(types).toEqual(["chat_op_started", "stream", "reasoning", "tool_start", "tool_end", "error", "done"]);
    const reasoningFrame = frames().find(f => f.event?.type === "reasoning")!;
    expect(reasoningFrame.event).toMatchObject({ replace: true, text: "let me check the docs" });
  });

  it("(c) a turn with no reasoning sends no reasoning frame", () => {
    const m = buildManager();
    const { onEvent } = m.startChat("s-no-think");
    onEvent(delta("plain answer"));
    onEvent(toolStart);
    onEvent(toolEnd);

    const { ws, frames } = makeWs();
    replayBufferedEvents(ws, "s-no-think");
    expect(frames().some(f => f.event?.type === "reasoning")).toBe(false);
    const types = frames().map(f => (f.event as { type: string }).type);
    expect(types).toEqual(["stream", "tool_start", "tool_end"]);
  });
});

describe("op_heartbeat keepalive (2026-07-13 audit I3)", () => {
  // A single long tool call (build, npm install) emits nothing for 60s+, so
  // the client's stuck-stream watchdog (public/js/chat-ws.js, 60s threshold
  // on lastActivityMs) fired reconnect_op replays against healthy turns. The
  // manager now broadcasts a lightweight op_heartbeat every 20s while the
  // turn is live; chat-stream-store.js applyEvent's default case bumps
  // lastActivityMs for any event type, so no client changes are needed.
  const doneEvent: ServerEvent = {
    type: "done",
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  } as ServerEvent;

  const heartbeatFrames = (frames: Frame[]) =>
    frames.filter(f => f.event?.type === "op_heartbeat");

  beforeEach(() => {
    vi.useFakeTimers();
    return () => vi.useRealTimers();
  });

  it("(a) live chat + subscribed client → one heartbeat at 20s, more after", () => {
    const m = buildManager();
    m.startChat("s-hb");
    const { ws, frames } = makeWs();
    clients.set(ws, new Set(["s-hb"]));

    vi.advanceTimersByTime(20_000);
    expect(heartbeatFrames(frames())).toHaveLength(1);
    expect(frames().at(-1)).toMatchObject({ type: "event", sessionId: "s-hb" });

    vi.advanceTimersByTime(60_000);
    expect(heartbeatFrames(frames())).toHaveLength(4);
  });

  it("(b) after done, advancing time produces no further heartbeats", () => {
    const m = buildManager();
    const { onEvent } = m.startChat("s-hb-done");
    const { ws, frames } = makeWs();
    clients.set(ws, new Set(["s-hb-done"]));

    vi.advanceTimersByTime(20_000);
    expect(heartbeatFrames(frames())).toHaveLength(1);

    onEvent(doneEvent);
    vi.advanceTimersByTime(120_000);
    expect(heartbeatFrames(frames())).toHaveLength(1);
  });

  it("(c) an overwritten entry's interval self-clears via the identity check", () => {
    const m = buildManager();
    // Old turn stays live (done:false) — only the identity check can stop
    // its interval once a successor overwrites the map entry.
    m.startChat("s-hb-dup");
    const { onEvent: onNew } = m.startChat("s-hb-dup");
    const { ws, frames } = makeWs();
    clients.set(ws, new Set(["s-hb-dup"]));

    // Finish the NEW turn; any heartbeat after this can only come from the
    // OLD interval failing to self-clear.
    onNew(doneEvent);
    vi.advanceTimersByTime(120_000);
    expect(heartbeatFrames(frames())).toHaveLength(0);
  });

  it("(e) a leaked entry (done never lands) stops heartbeating at the lifetime cap", () => {
    // Backstop for entry-leak paths (2026-07-13 audit, skeptic finding):
    // e.g. emitTurnError bypassing onEvent leaves done=false forever. Without
    // the cap the immortal heartbeat would keep the client's activity clock
    // fresh and mask the phantom stream from the watchdog indefinitely.
    const CAP = 4 * 60 * 60 * 1000;
    const m = buildManager();
    m.startChat("s-hb-leak");
    const { ws, frames } = makeWs();
    clients.set(ws, new Set(["s-hb-leak"]));

    // Heartbeats flow normally while under the cap.
    vi.advanceTimersByTime(20_000);
    expect(heartbeatFrames(frames())).toHaveLength(1);

    // Run out the rest of the cap, then measure a 10-minute window past it:
    // not a single further heartbeat.
    vi.advanceTimersByTime(CAP - 20_000);
    const atCap = heartbeatFrames(frames()).length;
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(heartbeatFrames(frames())).toHaveLength(atCap);
    // The entry itself is still leaked (done never landed) — the cap only
    // silences the keepalive so the client watchdog can recover the session.
    expect(activeChats.get("s-hb-leak")!.done).toBe(false);
  });

  it("(d) heartbeats never land in chat.events (no replay noise)", () => {
    const m = buildManager();
    m.startChat("s-hb-buf");
    const { ws } = makeWs();
    clients.set(ws, new Set(["s-hb-buf"]));

    vi.advanceTimersByTime(60_000);
    const chat = activeChats.get("s-hb-buf")!;
    expect(chat.events.some(e => (e as { type: string }).type === "op_heartbeat")).toBe(false);
    expect(chat.events).toHaveLength(0);
  });
});

describe("delta coalescing (2026-07-13 audit I2)", () => {
  // The token hot path used to broadcast every stream/reasoning delta
  // immediately — one JSON.stringify + N ws.sends per token. onEvent now
  // buffers delta text in an ordered {lane, text} run queue and flushes on a
  // 30ms timer (~33 paints/sec) or synchronously before ANY non-delta event,
  // so the client-visible order is unchanged while per-token overhead drops
  // ~10x. Accumulators stay synchronous — only the broadcast is deferred.
  const reasoning = (d: string): ServerEvent => ({ type: "reasoning", delta: d });
  const doneEvent: ServerEvent = {
    type: "done",
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  } as ServerEvent;

  const eventFrames = (frames: Frame[]) => frames.filter(f => f.type === "event");

  beforeEach(() => {
    vi.useFakeTimers();
    return () => vi.useRealTimers();
  });

  it("(a) three deltas within 30ms broadcast as ONE coalesced stream frame", () => {
    const m = buildManager();
    const { onEvent } = m.startChat("s-co");
    const { ws, frames } = makeWs();
    clients.set(ws, new Set(["s-co"]));

    onEvent(delta("a "));
    onEvent(delta("b "));
    onEvent(delta("c"));
    // Nothing on the wire before the window closes.
    expect(eventFrames(frames())).toHaveLength(0);

    vi.advanceTimersByTime(30);
    const evs = eventFrames(frames());
    expect(evs).toHaveLength(1);
    expect(evs[0].event).toMatchObject({ type: "stream", delta: "a b c" });
    // The accumulator was never deferred.
    expect(activeChats.get("s-co")!.streamText).toBe("a b c");
  });

  it("(b) a non-delta event flushes pending deltas FIRST (stream then tool_start)", () => {
    const m = buildManager();
    const { onEvent } = m.startChat("s-co-tool");
    const { ws, frames } = makeWs();
    clients.set(ws, new Set(["s-co-tool"]));

    onEvent(delta("searching"));
    onEvent(toolStart); // synchronous flush-then-broadcast — no timer needed
    const types = eventFrames(frames()).map(f => (f.event as { type: string }).type);
    expect(types).toEqual(["stream", "tool_start"]);
    expect(eventFrames(frames())[0].event).toMatchObject({ delta: "searching" });

    // The window is now empty: the timer must not re-send anything.
    vi.advanceTimersByTime(60);
    expect(eventFrames(frames())).toHaveLength(2);
  });

  it("(c) pending deltas flush before the done frame", () => {
    const m = buildManager();
    const { onEvent } = m.startChat("s-co-done");
    const { ws, frames } = makeWs();
    clients.set(ws, new Set(["s-co-done"]));

    onEvent(delta("tail text"));
    onEvent(doneEvent);
    const evs = eventFrames(frames()).filter(f => f.event?.type !== "op_heartbeat");
    expect(evs.map(f => (f.event as { type: string }).type)).toEqual(["stream", "done"]);
    expect(evs[0].event).toMatchObject({ delta: "tail text" });
  });

  it("(d) interleaved stream/reasoning deltas flush in arrival order, merged per run", () => {
    const m = buildManager();
    const { onEvent } = m.startChat("s-co-lanes");
    const { ws, frames } = makeWs();
    clients.set(ws, new Set(["s-co-lanes"]));

    onEvent(reasoning("think "));
    onEvent(reasoning("hard"));
    onEvent(delta("answer "));
    onEvent(delta("text"));
    onEvent(reasoning(" more"));
    vi.advanceTimersByTime(30);

    // Three runs — consecutive same-lane deltas merged, inter-lane order kept.
    const evs = eventFrames(frames()).map(f => f.event as { type: string; delta: string });
    expect(evs).toEqual([
      { type: "reasoning", delta: "think hard" },
      { type: "stream", delta: "answer text" },
      { type: "reasoning", delta: " more" },
    ]);
  });

  it("(e) terminateChat mid-window strands the tail: no late delta after done", () => {
    // terminateChat bypasses onEvent (pushes error/done into chat.events +
    // broadcasts directly), so it cannot flush the manager closure's pending
    // deltas. A LATE flush after the client processed done would append to a
    // parked bubble with anchor -1 — the flush callback therefore gates on
    // chat.done and DROPS the ≤30ms tail. Replay is still whole: the
    // accumulator was updated synchronously.
    const m = buildManager();
    const { onEvent } = m.startChat("s-co-stop");
    const { ws, frames } = makeWs();
    clients.set(ws, new Set(["s-co-stop"]));

    onEvent(delta("partial "));
    onEvent(delta("tail"));
    terminateChat("s-co-stop", { abort: false, errorMessage: "stopped" });
    const beforeTimer = eventFrames(frames()).map(f => (f.event as { type: string }).type);
    expect(beforeTimer).toEqual(["error", "done"]);

    vi.advanceTimersByTime(60);
    // No stream frame ever lands — the tail was dropped, not delivered late.
    expect(eventFrames(frames()).some(f => f.event?.type === "stream")).toBe(false);
    // But the accumulator (what replay serves) holds the full text.
    expect(activeChats.get("s-co-stop")!.streamText).toBe("partial tail");
  });

  it("(f) a stream replace is non-delta: pending flushes first, then the replace", () => {
    const m = buildManager();
    const { onEvent } = m.startChat("s-co-replace");
    const { ws, frames } = makeWs();
    clients.set(ws, new Set(["s-co-replace"]));

    onEvent(delta('{"tool":"x"}'));
    onEvent({ type: "stream", replace: true, text: "" } as ServerEvent);
    const evs = eventFrames(frames()).map(f => f.event as Record<string, unknown>);
    expect(evs).toEqual([
      { type: "stream", delta: '{"tool":"x"}' },
      { type: "stream", replace: true, text: "" },
    ]);
  });
});

describe("backpressure guard on delta broadcasts (2026-07-13 audit I2)", () => {
  // A hung/slow client never drains its socket, so per-token sends buffer
  // unboundedly in this process. broadcastToSession now skips DELTA-shaped
  // stream/reasoning frames for any socket with bufferedAmount over 1MB;
  // replace/terminal/tool frames are never dropped, and the watchdog
  // replay's replace repairs the dropped text.
  beforeEach(() => {
    vi.useFakeTimers();
    return () => vi.useRealTimers();
  });

  it("a backed-up socket receives tool_start but not the delta; a healthy one gets both", () => {
    const m = buildManager();
    const { onEvent } = m.startChat("s-bp");
    const slow = makeWs(1_000_001); // just over BACKPRESSURE_MAX_BUFFERED
    const fast = makeWs(0);
    clients.set(slow.ws, new Set(["s-bp"]));
    clients.set(fast.ws, new Set(["s-bp"]));

    onEvent(delta("token"));
    vi.advanceTimersByTime(30); // close the coalescing window
    onEvent(toolStart);

    const slowTypes = slow.frames().map(f => (f.event as { type: string }).type);
    const fastTypes = fast.frames().map(f => (f.event as { type: string }).type);
    expect(slowTypes).toEqual(["tool_start"]);
    expect(fastTypes).toEqual(["stream", "tool_start"]);
  });

  it("replace and terminal frames are never dropped, even on a backed-up socket", () => {
    const m = buildManager();
    const { onEvent } = m.startChat("s-bp-replace");
    const slow = makeWs(50_000_000);
    clients.set(slow.ws, new Set(["s-bp-replace"]));

    onEvent(delta("draft"));
    onEvent({ type: "stream", replace: true, text: "final" } as ServerEvent);
    terminateChat("s-bp-replace", { abort: false, errorMessage: "provider died" });

    const types = slow.frames()
      .filter(f => f.type === "event")
      .map(f => (f.event as { type: string }).type + ("replace" in (f.event ?? {}) ? ":replace" : ""));
    // The buffered delta was flushed by the replace but dropped at the socket;
    // the replace itself and the terminals all got through.
    expect(types).toEqual(["stream:replace", "error", "done"]);
  });
});

describe("failChatIfCurrent identity guard (2026-07-13 audit, skeptic round 2)", () => {
  // Wedge clobber: T1's provider ignores its abort >5s, T2's
  // tryAcquireOrReplace force-releases the lock and T2's startChat overwrites
  // the map entry. Minutes later T1 un-wedges, throws, and its terminal net
  // fires. A bare failChat would find T2's LIVE entry and mark it done —
  // T2's remaining events all drop on the onEvent done-guard, Stop no-ops,
  // and the client sees done mid-stream. The token (the entry's own
  // AbortController, startChat's `.abort` return) pins the terminate to the
  // caller's OWN entry.
  const doneEvent: ServerEvent = {
    type: "done",
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  } as ServerEvent;

  it("an overwritten turn's token cannot terminate the successor's live entry", () => {
    const m = buildManager();
    const t1 = m.startChat("s-guard"); // the turn that will wedge
    const t2 = m.startChat("s-guard"); // successor overwrites the slot

    // T1's late error path: refused — successor owns the sessionId now.
    expect(m.failChatIfCurrent("s-guard", t1.abort, "")).toBe(false);
    const current = activeChats.get("s-guard")!;
    expect(current.abortController).toBe(t2.abort); // still T2's entry
    expect(current.done).toBe(false);               // still live + stoppable
    expect(current.events.some(e => e.type === "done")).toBe(false); // no buffered terminal

    // The rightful owner's token DOES terminate it (buffered terminal done).
    expect(m.failChatIfCurrent("s-guard", t2.abort, "")).toBe(true);
    expect(current.done).toBe(true);
    expect(current.events.some(e => e.type === "done")).toBe(true);
  });

  it("no-ops on an entry that already went done through onEvent (happy-path net)", () => {
    const m = buildManager();
    const t = m.startChat("s-guard-done");
    t.onEvent(doneEvent);
    expect(m.failChatIfCurrent("s-guard-done", t.abort, "")).toBe(false);
  });

  it("no-ops when the entry is gone entirely", () => {
    const m = buildManager();
    expect(m.failChatIfCurrent("s-guard-missing", new AbortController(), "")).toBe(false);
    expect(activeChats.has("s-guard-missing")).toBe(false);
  });
});

