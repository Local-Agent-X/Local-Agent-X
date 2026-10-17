// Late-subscriber replay for a session's in-flight (or lingering) chat.
// Split from state.ts (2026-07-13) to keep that module under the 400-LOC
// hygiene gate; state.ts owns the maps and terminate semantics, this module
// owns only the read-side replay built from them.

import type { WebSocket } from "ws";
import type { ServerEvent } from "../types.js";
import { activeChats, type ActiveChat } from "./state.js";
import { sendFrame } from "./frames.js";

/**
 * True when the subscriber provably already rendered this finished turn, so a
 * replay would append it a second time (phone, field 2026-10-13: back out of a
 * chat and return, or switch networks, right after a reply). Either fact is
 * proof: its history was read strictly after the turn was saved (both times on
 * the server clock; same millisecond does not count), or it received the
 * turn's own `done`. Anything less certain replays as always: a duplicate is
 * recoverable, a lost reply is not.
 */
function subscriberHoldsTurn(chat: ActiveChat, has: SubscriberHas): boolean {
  if (has.historyAsOf !== undefined && chat.persistedAt !== undefined && chat.persistedAt < has.historyAsOf) return true;
  return has.doneOpId !== undefined && chat.opId !== undefined && chat.opId === has.doneOpId;
}

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
/** What a re-subscribing client says it already holds (subscribe frame). */
export interface SubscriberHas {
  /** Server time it read the session's history (GET /api/sessions/<id> `asOf`). */
  historyAsOf?: number;
  /** The op of the last turn it received through `done`. */
  doneOpId?: string;
}

export function replayBufferedEvents(ws: WebSocket, sessionId: string, has: SubscriberHas = {}): void {
  const chat = activeChats.get(sessionId);
  if (!chat) return;
  if (chat.done && subscriberHoldsTurn(chat, has)) return;
  // The synthesized wipe and run frames are built here, not drawn from the
  // event buffer, so they are typed by hand.
  const send = (event: unknown) =>
    sendFrame(ws, { type: "event", sessionId, event: event as ServerEvent, _replay: true });
  for (const event of chat.events) {
    if (event.type !== "chat_op_started") continue;
    sendFrame(ws, { type: "event", sessionId, event });
  }
  // Gate each wipe on sawStream/sawReasoning, not accumulator truthiness: an
  // empty accumulator after a stream event means the extractor REPLACED the
  // text with "" (visible text was all tool-call JSON) — the client needs
  // that empty wipe to clear its stale partial. No lane activity → no frame.
  // Each wipe carries the turn's CURRENT text position, which becomes the
  // client's new baseline: every text frame the turn has broadcast so far is
  // accounted for by the runs that follow, so a copy of one still in flight on
  // another socket (an orphan the client hasn't finished closing — live
  // failure 2026-09-21) is recognized as already-applied and dropped instead
  // of appending a second time. The run deltas below deliberately carry NO
  // seq: they are bracketed by the wipe and authoritative by position.
  if (chat.sawStream) send({ type: "stream", replace: true, text: "", seq: chat.textSeq });
  if (chat.sawReasoning) send({ type: "reasoning", replace: true, text: "", seq: chat.textSeq });
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
    sendFrame(ws, { type: "event", sessionId, event });
  }
}
