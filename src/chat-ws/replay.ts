// Late-subscriber replay for a session's in-flight (or lingering) chat.
// Split from state.ts (2026-07-13) to keep that module under the 400-LOC
// hygiene gate; state.ts owns the maps and terminate semantics, this module
// owns only the read-side replay built from them.

import type { WebSocket } from "ws";
import { activeChats } from "./state.js";

/**
 * Replay a session's buffered events to a late/reconnecting subscriber.
 *
 * Stream text is sent as a single `replace: true` event built from the
 * chat.streamText ACCUMULATOR, never reconstructed from buffered deltas
 * (CT-3, hardened 2026-07-13). Two live failures drove this shape:
 *
 * - 2026-05-19: replaying raw deltas onto a client that still holds the
 *   pre-blip partial (mid-turn WS blip → re-subscribe) double-counts the
 *   text into the live bubble AND into persisted history when
 *   promoteLiveToMessages runs on `done`. One `replace` sets the client's
 *   content to the exact accumulated text regardless of what it already
 *   holds — the same duplication fix handleReconnectOp applies for
 *   finalized op_messages.
 * - 2026-07-13 audit: coalescing from chat.events truncated the text. The
 *   manager trims the buffer to the last 400 events past 500, so any turn
 *   longer than ~500 per-token deltas replayed only the TAIL — the replace
 *   overwrote the client's fuller partial and `done` persisted the stub.
 *   (session_snapshot can't repair it: it re-hydrates only when the server
 *   messageCount exceeds local, and the counts match.) manager.onEvent now
 *   folds stream events into chat.streamText and keeps them OUT of
 *   chat.events, so the trim is a backstop over the small non-stream list
 *   and can never eat streamed text.
 *
 * Frame order: chat_op_started events FIRST (relative order preserved),
 * then the coalesced replace, then the remaining buffered events in order.
 * op_started precedes all stream text chronologically, so it must replay
 * before the replace: the client wipes its per-turn scratch on a
 * done→streaming transition (reconnect onto a finished entry after a NEW
 * op started while disconnected — chat-stream-store.js applyEvent), and
 * that wipe has to run BEFORE the replace refills content, not after (an
 * op_started replayed after the replace destroyed the just-replayed text).
 * The replace still precedes any trailing `error`/`done` (`error` appends
 * to content; a `replace` after `error` would wipe it). Non-stream events
 * are idempotent client-side (tool_* dedupe by call id, done is terminal).
 */
export function replayBufferedEvents(ws: WebSocket, sessionId: string): void {
  const chat = activeChats.get(sessionId);
  if (!chat) return;
  for (const event of chat.events) {
    if (event.type !== "chat_op_started") continue;
    ws.send(JSON.stringify({ type: "event", sessionId, event }));
  }
  // Gate on sawStream, not streamText truthiness: an empty accumulator after
  // a stream event means the extractor REPLACED the text with "" (visible
  // text was all tool-call JSON) — the client needs that empty replace to
  // wipe its stale partial. No stream at all → send nothing.
  if (chat.sawStream) {
    ws.send(JSON.stringify({
      type: "event",
      sessionId,
      event: { type: "stream", replace: true, text: chat.streamText },
      _replay: true,
    }));
  }
  // Reasoning mirrors the stream lane — same duplication class: the client
  // APPENDS live reasoning deltas onto whatever Thinking text it already
  // holds, so replaying raw deltas double-counts it. One coalesced replace
  // reproduces the client state exactly: reasoning and answer text
  // interleave live but the client keeps them on separate lanes
  // (reasoning vs content), so per-lane coalescing loses nothing. Ordering:
  // it must follow the op_started frames above — the client's done→streaming
  // scratch wipe (chat-stream-store.js applyEvent 'chat_op_started') resets
  // `reasoning` too and has to run before this refill. Placement relative to
  // the stream replace is arbitrary (different lanes); keep it after so the
  // frame sequence stays op_started → stream → reasoning, mirroring build
  // order here.
  if (chat.sawReasoning) {
    ws.send(JSON.stringify({
      type: "event",
      sessionId,
      event: { type: "reasoning", replace: true, text: chat.reasoningText },
      _replay: true,
    }));
  }
  for (const event of chat.events) {
    if (event.type === "chat_op_started") continue;
    ws.send(JSON.stringify({ type: "event", sessionId, event }));
  }
}
