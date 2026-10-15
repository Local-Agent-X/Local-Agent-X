// Shared chat-ws state: active sessions, connected clients, and the
// per-turn accumulators replay is rebuilt from.
//
// Single source of truth for who's connected and who's listening to
// which sessionId. Other chat-ws modules import from here rather than
// passing closures around. Everything that SENDS over these maps —
// per-session fan-out, the active_chats listing, broadcast-to-all,
// terminateChat — lives in ./broadcast.ts (split 2026-09-01, 400-LOC gate).

import type { WebSocket } from "ws";
import type { ServerEvent } from "../types.js";
import { replaceLane } from "../broker-transport/vendor/protocol.js";

/** One uninterrupted run of same-lane turn output, in ARRIVAL order across
 *  lanes — the ordered twin of the flat streamText/reasoningText
 *  accumulators. Replay walks this so a reconnecting client can rebuild the
 *  turn's block timeline (thinking / text / injects interleaved) instead of
 *  receiving two flattened lane blobs. `boundary` marks a run whose text
 *  followed a tool call — the client splits its timeline there because the
 *  buffered tool events replay AFTER the text, not interleaved with it. */
export type TurnRun =
  | { lane: "stream" | "reasoning"; text: string; boundary?: boolean }
  | { lane: "inject"; injectId: string; text: string };

export interface ActiveChat {
  sessionId: string;
  events: ServerEvent[];       // Buffered NON-stream events for replay (see streamText)
  /** Accumulated assistant text for this turn. Stream events are folded in
   *  here by manager.onEvent instead of being pushed into `events`, so the
   *  500/400 buffer trim can never truncate the text a reconnecting client
   *  is sent (trim-truncation bug, 2026-07-13 audit). */
  streamText: string;
  /** True once ANY stream event (delta or replace) passed through onEvent.
   *  This — not streamText truthiness — gates the replay's replace frame:
   *  the tool-call-from-text extractor (chat-runner/event-pump.ts) emits
   *  `replace` with text:"" when the model's entire visible text was
   *  tool-call JSON. That empty replace is a CORRECTIVE signal — a client
   *  that blipped after streaming the JSON needs it on replay to wipe the
   *  stale JSON from its bubble, or `done` persists the JSON. Gating on a
   *  truthy streamText would drop exactly that frame (skeptic catch,
   *  2026-07-13). */
  sawStream: boolean;
  /** Accumulated chain-of-thought for this turn — the reasoning lane's twin
   *  of streamText. `reasoning` deltas are per-token (event-pump.ts), so
   *  buffering them in `events` both blew the 500/400 trim (evicting
   *  buffered tool_start/tool_end/chat_op_started from replays) AND
   *  double-counted on replay (the client APPENDS reasoning deltas onto the
   *  text it already holds). Plain append, no paragraph-break logic — the
   *  client's reasoning lane appends plainly too. */
  reasoningText: string;
  /** Mirrors sawStream for the reasoning lane: true once ANY reasoning
   *  event passed through onEvent; gates the replay's coalesced replace. */
  sawReasoning: boolean;
  /** Mirrors the client store's toolsSinceText: a tool_start/tool_end landed
   *  since the last text delta. The client inserts "\n\n" before the next
   *  delta in that case (chat-stream-reducer.js); the accumulator must do
   *  the same or the replayed text differs from the live render by exactly
   *  those paragraph breaks. */
  toolsSinceText: boolean;
  /** Ordered runs for replay (see TurnRun). Run texts are EXACT slices of
   *  the flat accumulators — the paragraph break the accumulator inserts at
   *  a tool boundary is part of the run's text — so a legacy client that
   *  just appends the replayed run deltas lands on byte-identical lane
   *  text. */
  runs: TurnRun[];
  /** A tool event landed since the last run append: the next delta of
   *  EITHER lane starts a new run (stamped boundary:true) instead of
   *  merging into the tail. */
  runBoundary: boolean;
  /** Monotonic position of the last text-bearing frame BROADCAST for this
   *  turn — one counter across both lanes, because the client applies them
   *  to one ordered timeline. Stamped onto every live stream/reasoning frame
   *  (manager.ts flushPendingDeltas and the replace branch) so the client can
   *  recognize a frame it has already applied.
   *
   *  Text is the only event class with no natural identity: tool_* dedupe by
   *  toolCallId, approval_* by approvalId, `error` by its own text, `done` is
   *  terminal — so a duplicate delivery of any of those is a no-op, while a
   *  duplicate `stream` delta silently appends twice (live failure
   *  2026-09-21: a socket orphaned by a 218s event-loop stall kept delivering
   *  alongside its replacement; the bubble showed the answer twice,
   *  interleaved). This is that identity. Gaps are expected and harmless —
   *  backpressure drops delta frames (broadcast.ts) and the replay repairs
   *  the hole — so the client compares with <=, never for contiguity. */
  textSeq: number;
  /** Canonical op this turn's channel is streaming, learned from the turn's
   *  own `chat_op_started` (manager.onEvent). Two readers: the channel stamps
   *  it onto every live envelope so a client can tell a dead turn's frames
   *  from its replacement's, and a successor startChat reads it off the entry
   *  it overwrites to name the op that takeover superseded. Undefined until
   *  the turn announces an op — channels outside a canonical chat turn (the
   *  delegation ack) never emit chat_op_started, so theirs stays unset. */
  opId?: string;
  abortController: AbortController;
  startedAt: number;
  done: boolean;
  /** When the finished turn landed in session.messages (server clock). The
   *  canonical run emits `done` BEFORE persisting, so a done turn is not yet
   *  in the history a client can fetch; replay uses this to know when it is
   *  (replayBufferedEvents). Unset until markTurnPersisted. */
  persistedAt?: number;
}

/** Fold one delta's appended text into the ordered run list. `s` must be the
 *  exact bytes appended to the flat accumulator (including any paragraph
 *  break) so the two representations can't drift. */
export function appendRun(chat: ActiveChat, lane: "stream" | "reasoning", s: string): void {
  if (!s) return;
  const tail = chat.runs[chat.runs.length - 1];
  if (tail && tail.lane === lane && !chat.runBoundary) {
    tail.text += s;
    return;
  }
  chat.runs.push(chat.runBoundary ? { lane, text: s, boundary: true } : { lane, text: s });
  chat.runBoundary = false;
}

/** `replace` semantics for one lane's runs: the shared rule (vendor/timeline.ts), the
 *  same function the web client's blocks (public/js/agentxos-timeline.js, generated)
 *  and the phone run, so a live client and a reconnecting one land on the same
 *  timeline. Runs of the other lanes (including injects) never move.
 *
 *  Excess past everything the lane had streamed opens a run at the tail with
 *  boundary:true, so a replaying client splits a block there rather than merging
 *  the excess into whatever run happens to sit before it. */
export function replaceRunLane(chat: ActiveChat, lane: "stream" | "reasoning", text: string): void {
  chat.runs = replaceLane(chat.runs, text ?? "", {
    laneText: (run) => (run.lane === lane ? run.text : null),
    withText: (run, t) => ({ ...run, text: t }),
    create: (t) => ({ lane, text: t, boundary: true }),
  });
}

/** Record a consumed mid-turn inject at its position in the turn's timeline
 *  so replay can rebuild the inline inject bubble. Called by
 *  drainInjectsIntoTurn (canonical-loop) — the inject event path bypasses
 *  manager.onEvent, so it can't be folded there. No-op when no live entry. */
export function recordInjectRun(sessionId: string, injectId: string, text: string): void {
  const chat = activeChats.get(sessionId);
  if (!chat || chat.done) return;
  chat.runs.push({ lane: "inject", injectId, text });
  chat.runBoundary = true;
}

/** The session's finished turn is now in session.messages. Called by the chat
 *  run right after it persists. A turn still running is never marked: a new
 *  turn that took the session's entry in the meantime is not the one that was
 *  persisted. */
export function markTurnPersisted(sessionId: string): void {
  const chat = activeChats.get(sessionId);
  if (chat?.done) chat.persistedAt = Date.now();
}

// Active chats — keyed by sessionId.
export const activeChats = new Map<string, ActiveChat>();

// Connected clients — each client subscribes to sessionIds.
export const clients = new Map<WebSocket, Set<string>>();

// Message-count provider for the session_snapshot event. Wired from
// src/server/index.ts where SessionStore is in scope; the chat-ws layer
// doesn't import SessionStore directly to avoid a circular dependency.
let messageCountForSession: ((sessionId: string) => number) | null = null;
export function setMessageCountForSession(fn: (sessionId: string) => number): void {
  messageCountForSession = fn;
}
export function getMessageCountForSession(): ((sessionId: string) => number) | null {
  return messageCountForSession;
}

// Learned-procedure notices still waiting on the user, for the same snapshot:
// a notice broadcast while no client was subscribed is re-delivered here.
// Wired from src/server/index.ts for the same layering reason as above.
let learningNoticesForSession: ((sessionId: string) => unknown[]) | null = null;
export function setLearningNoticesForSession(fn: (sessionId: string) => unknown[]): void {
  learningNoticesForSession = fn;
}
export function getLearningNoticesForSession(): ((sessionId: string) => unknown[]) | null {
  return learningNoticesForSession;
}
