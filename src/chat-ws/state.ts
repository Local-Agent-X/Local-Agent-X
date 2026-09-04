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

/** `replace` semantics for one lane's runs — order-preserving, and the exact
 *  twin of replaceBlockLane in public/js/chat-stream-blocks.js. The two rules
 *  MUST stay identical: a live client applies the replace to its blocks, a
 *  reconnecting one rebuilds from these runs, and they have to land on the
 *  same timeline.
 *
 *  The replacement is a lightly edited derivative of the bytes already
 *  streamed (tool-call-from-text extraction, the delivery-time sanitize
 *  repair, the replay wipe's ""), so it diverges late or not at all. Keep
 *  every run the replacement still agrees with byte-for-byte; only from the
 *  first differing byte is positional history void — the remainder lands in
 *  the run where the divergence began and later runs of that lane go away.
 *  Runs of the other lanes (including injects) never move.
 *
 *  Postcondition: the lane's runs concatenate to `text`. */
export function replaceRunLane(chat: ActiveChat, lane: "stream" | "reasoning", text: string): void {
  const replacement = text ?? "";
  const next: TurnRun[] = [];
  let cursor = 0;
  let diverged = false;
  for (const run of chat.runs) {
    if (run.lane === "inject" || run.lane !== lane) { next.push(run); continue; }
    if (diverged) continue; // lane history past the split point is void
    if (replacement.startsWith(run.text, cursor)) {
      cursor += run.text.length;
      next.push(run);
      continue;
    }
    diverged = true;
    const rest = replacement.slice(cursor);
    cursor = replacement.length;
    if (rest) next.push({ ...run, text: rest });
  }
  // Replacement runs past everything this lane had streamed (or the lane had
  // no runs at all): the excess is new text, so it opens a run at the tail.
  // boundary:true so a replaying client splits a block there rather than
  // merging the excess into whatever run happens to sit before it.
  if (!diverged && cursor < replacement.length) {
    next.push({ lane, text: replacement.slice(cursor), boundary: true });
  }
  chat.runs = next;
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
