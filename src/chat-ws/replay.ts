// Late-subscriber replay for a session's in-flight (or lingering) chat.
// Split from state.ts (2026-07-13) to keep that module under the 400-LOC
// hygiene gate; state.ts owns the maps and terminate semantics, this module
// owns only the read-side replay built from them.

import type { WebSocket } from "ws";
import { activeChats } from "./state.js";

/**
 * Replay a session's buffered events to a late/reconnecting subscriber.
 *
 * Turn text replays as a per-lane WIPE (`replace` with text:"") followed by
 * the ordered runs from the chat.runs ACCUMULATOR as delta frames — never
 * reconstructed from buffered raw deltas (CT-3, hardened 2026-07-13;
 * ordered runs 2026-07-16). The shape's history:
 *
 * - 2026-05-19: replaying raw deltas onto a client that still holds the
 *   pre-blip partial (mid-turn WS blip → re-subscribe) double-counts the
 *   text into the live bubble AND into persisted history when
 *   promoteLiveToMessages runs on `done`. The wipe first sets the client's
 *   lane to empty regardless of what it already holds; the run deltas then
 *   rebuild exactly the accumulated text.
 * - 2026-07-13 audit: coalescing from chat.events truncated the text. The
 *   manager trims the buffer to the last 400 events past 500, so any turn
 *   longer than ~500 per-token deltas replayed only the TAIL. manager.onEvent
 *   now folds stream/reasoning events into the accumulators and keeps them
 *   OUT of chat.events, so the trim is a backstop over the small non-stream
 *   list and can never eat streamed text.
 * - 2026-07-16: one coalesced replace per lane flattened the turn's
 *   TIMELINE — a reconnecting client got "all thinking" then "all text",
 *   losing where each thinking phase and mid-turn inject actually happened.
 *   chat.runs preserves arrival order across lanes; replaying it as delta
 *   frames (boundary-stamped where a tool call split the text, since the
 *   buffered tool events replay AFTER the text, not interleaved) lets the
 *   block-timeline client rebuild the exact live layout. A legacy client
 *   just appends the same bytes after the wipe and lands on identical lane
 *   text — run texts are exact accumulator slices, paragraph breaks
 *   included.
 *
 * Inject runs replay as `inject_consumed` frames carrying the message text
 * so a client whose local echo died (mid-turn reload) can materialize the
 * inline bubble at the right point in the timeline.
 *
 * Frame order: chat_op_started events FIRST (relative order preserved),
 * then the per-lane wipes, then the ordered runs, then the remaining
 * buffered events in order. op_started precedes all stream text
 * chronologically, so it must replay before the wipes: the client wipes its
 * per-turn scratch on a done→streaming transition (reconnect onto a
 * finished entry after a NEW op started while disconnected —
 * chat-stream-reducer.js), and that wipe has to run BEFORE the runs refill
 * content, not after. The runs still precede any trailing `error`/`done`
 * (`error` appends to content; a wipe after `error` would eat it).
 * Non-stream events are idempotent client-side (tool_* dedupe by call id,
 * done is terminal).
 *
 * Every text-bearing frame carries envelope `_replay: true` so client-side
 * side effects keyed to live deltas (TTS) know to skip it.
 */
export function replayBufferedEvents(ws: WebSocket, sessionId: string): void {
  const chat = activeChats.get(sessionId);
  if (!chat) return;
  const send = (event: unknown) =>
    ws.send(JSON.stringify({ type: "event", sessionId, event, _replay: true }));
  for (const event of chat.events) {
    if (event.type !== "chat_op_started") continue;
    ws.send(JSON.stringify({ type: "event", sessionId, event }));
  }
  // Gate each wipe on sawStream/sawReasoning, not accumulator truthiness: an
  // empty accumulator after a stream event means the extractor REPLACED the
  // text with "" (visible text was all tool-call JSON) — the client needs
  // that empty wipe to clear its stale partial. No lane activity → no frame.
  if (chat.sawStream) send({ type: "stream", replace: true, text: "" });
  if (chat.sawReasoning) send({ type: "reasoning", replace: true, text: "" });
  for (const run of chat.runs) {
    if (run.lane === "inject") {
      send({ type: "inject_consumed", injectId: run.injectId, message: run.text });
    } else {
      send(run.boundary
        ? { type: run.lane, delta: run.text, boundary: true }
        : { type: run.lane, delta: run.text });
    }
  }
  for (const event of chat.events) {
    if (event.type === "chat_op_started") continue;
    ws.send(JSON.stringify({ type: "event", sessionId, event }));
  }
}
