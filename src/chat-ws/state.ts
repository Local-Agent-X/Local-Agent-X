// Shared chat-ws state: active sessions, connected clients, the chat
// handler hook, and the broadcast helpers that operate over both.
//
// Single source of truth for who's connected and who's listening to
// which sessionId. Other chat-ws modules import from here rather than
// passing closures around.

import type { WebSocket } from "ws";
import type { ServerEvent } from "../types.js";
import { hasChatHandlerPending } from "../ops/session-bridge.js";

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
  /** Mirrors the client store's toolsSinceText: a tool_start/tool_end landed
   *  since the last text delta. The client inserts "\n\n" before the next
   *  delta in that case (chat-stream-store.js applyEvent); the accumulator
   *  must do the same or the replayed replace differs from the live render
   *  by exactly those paragraph breaks. */
  toolsSinceText: boolean;
  abortController: AbortController;
  startedAt: number;
  done: boolean;
}

export type ChatHandler = (sessionId: string, message: string, attachments: unknown[]) => void;

// Active chats — keyed by sessionId.
export const activeChats = new Map<string, ActiveChat>();

// How long a terminated ActiveChat lingers before its buffer is swept.
// Matches manager.onEvent's natural-`done` sweep (5 min) so a stopped chat
// and a completed one are reclaimed on the same schedule.
const CHAT_SWEEP_DELAY_MS = 5 * 60 * 1000;

// ── Prep-window stop deferral (CT-4) ──────────────────────────────────────
//
// terminateChat needs an activeChats entry, but the entry is registered
// ~30-200ms AFTER the chat frame is accepted (lifecycle.wireWsChat marks the
// handler pending, runChatTurn preps, then installEventWiring → startChat).
// A Stop landing in that window used to be a silent no-op while the client
// had already painted [stopped] and closed the socket — loop and UI
// permanently disagreed. (The inject race in the same window got a
// pending-flag fix; stop never did.)
//
// A deferred stop is applied the instant the turn registers: startChat fires
// broadcastActiveChats synchronously after activeChats.set, which drains the
// map. If the prep turn dies BEFORE registering (missing credential, worker
// redirect, a prepare/route throw — all early exits in
// run-chat-turn/orchestrator.ts that end the turn with no ActiveChat),
// lifecycle's finally clears the pending flag and the poll below discards
// the stop — it must never linger and kill the user's NEXT legitimate turn
// on the same session.

const PENDING_STOP_POLL_MS = 25;
// Backstop only (leaked pending counter). Prep is 30-200ms; a stop this old
// no longer targets the turn the user saw — err on discarding.
const PENDING_STOP_MAX_WAIT_MS = 30_000;

interface PendingStop {
  opts: TerminateOptions;
  recordedAt: number;
  poll: NodeJS.Timeout;
}

const pendingStops = new Map<string, PendingStop>();

function recordPendingStop(sessionId: string, opts: TerminateOptions): void {
  const existing = pendingStops.get(sessionId);
  if (existing) { existing.opts = opts; return; } // second Stop in the window — keep the first poll
  const poll = setInterval(() => checkPendingStop(sessionId), PENDING_STOP_POLL_MS);
  poll.unref();
  pendingStops.set(sessionId, { opts, recordedAt: Date.now(), poll });
}

/** Remove and return the pending stop, stopping its poll. */
function takePendingStop(sessionId: string): PendingStop | undefined {
  const entry = pendingStops.get(sessionId);
  if (!entry) return undefined;
  clearInterval(entry.poll);
  pendingStops.delete(sessionId);
  return entry;
}

function checkPendingStop(sessionId: string): void {
  const chat = activeChats.get(sessionId);
  if (chat && !chat.done) {
    // Registered without a broadcast reaching us first — belt-and-suspenders;
    // drainPendingStops via startChat's broadcastActiveChats normally wins.
    const entry = takePendingStop(sessionId);
    if (entry) terminateChat(sessionId, entry.opts);
    return;
  }
  const entry = pendingStops.get(sessionId);
  if (!entry) return;
  // Pending flag dropped with no ActiveChat registered → the prep turn this
  // stop targeted died on an early exit. Discard; applying it later would
  // abort the user's next legitimate turn ("stop poisons the retry").
  if (!hasChatHandlerPending(sessionId) || Date.now() - entry.recordedAt > PENDING_STOP_MAX_WAIT_MS) {
    takePendingStop(sessionId);
  }
}

function drainPendingStops(): void {
  if (pendingStops.size === 0) return;
  for (const sessionId of [...pendingStops.keys()]) {
    const chat = activeChats.get(sessionId);
    // Only a LIVE entry consumes the stop. A lingering `done` entry from the
    // PREVIOUS turn (kept ~5 min for replay) must not — terminateChat would
    // no-op on it and the stop would be lost while the stopped turn is still
    // mid-prep.
    if (!chat || chat.done) continue;
    const entry = takePendingStop(sessionId);
    if (entry) terminateChat(sessionId, entry.opts);
  }
}

// Connected clients — each client subscribes to sessionIds.
export const clients = new Map<WebSocket, Set<string>>();

// Chat handler — set by the server to process WS chat messages.
let chatHandler: ChatHandler | null = null;
export function setChatHandler(h: ChatHandler): void { chatHandler = h; }
export function getChatHandler(): ChatHandler | null { return chatHandler; }

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

// Eval sessions (/api/eval/run) are dry-run throwaways that run a real chat
// turn purely to observe tool routing. They must never reach a browser:
// announcing one via active_chats makes the UI subscribe and render its
// streamed messages into the user's open chat. Filter them at the broadcast
// source so no client path can pick them up.
function isHeadlessSession(sessionId: string): boolean {
  return sessionId.startsWith("eval-");
}

export function broadcastToSession(sessionId: string, event: ServerEvent): void {
  if (isHeadlessSession(sessionId)) return;
  const payload = JSON.stringify({ type: "event", sessionId, event });
  for (const [ws, subs] of clients) {
    if (subs.has(sessionId) && ws.readyState === 1 /* OPEN */) {
      ws.send(payload);
    }
  }
}

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
 * The replace is sent FIRST so a trailing buffered `error`/`done` lands
 * after it (`error` appends to content; a `replace` after `error` would
 * wipe it). Non-stream events replay in order and are idempotent
 * client-side (tool_* dedupe by call id, done is terminal).
 */
export function replayBufferedEvents(ws: WebSocket, sessionId: string): void {
  const chat = activeChats.get(sessionId);
  if (!chat) return;
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
  for (const event of chat.events) {
    ws.send(JSON.stringify({ type: "event", sessionId, event }));
  }
}

export function broadcastActiveChats(): void {
  // startChat calls this synchronously right after registering an ActiveChat,
  // making it the earliest state-side hook to honor a stop that raced the
  // registration (CT-4).
  drainPendingStops();
  const activeIds = [...activeChats.keys()].filter(id => !activeChats.get(id)!.done && !isHeadlessSession(id));
  const payload = JSON.stringify({ type: "active_chats", sessionIds: activeIds });
  for (const [ws] of clients) {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(payload);
    }
  }
}

/** Broadcast a message to ALL connected WebSocket clients (for agent
 *  events that don't target a specific session). Used by app-tools,
 *  autopilot, routes/apps, routes/settings/* via dynamic import.
 *  Returns the number of OPEN clients that received the payload so
 *  callers can surface "(no UI clients to notify)" hints — the
 *  setting tool uses this to tell users to refresh manually when
 *  they flip a UI-affecting toggle with no tabs open. */
export function broadcastAll(data: Record<string, unknown>): number {
  const payload = JSON.stringify(data);
  let sent = 0;
  for (const [ws] of clients) {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(payload);
      sent++;
    }
  }
  return sent;
}

export interface TerminateOptions {
  /** Abort the in-flight provider stream + release the turn lock.
   *  `true` for user-initiated stop; `false` for transport-level failures
   *  where the orchestrator has already finished its side of the turn. */
  abort: boolean;
  /** Error message to broadcast before the terminal `done`. Empty string
   *  emits no error event (used by graceful-fail callers that only need
   *  the done). */
  errorMessage: string;
}

/**
 * Single source of truth for "this chat is over." Three former call sites
 * (manager.stopChat, manager.failChat, message-router.handleStop) had near-
 * identical bodies — every fix had to be made in three places. Consolidating
 * here means the next time we change termination semantics (e.g. dedup done,
 * add a reason code), it's one edit.
 *
 * Returns `true` iff the chat was live and we terminated it; `false` if the
 * session was unknown or already done.
 */
export function terminateChat(sessionId: string, opts: TerminateOptions): boolean {
  const chat = activeChats.get(sessionId);
  if (!chat || chat.done) {
    // CT-4: no live entry, but a chat handler is mid-prep for this session —
    // the turn exists, its ActiveChat just isn't registered yet. Defer the
    // stop (see the pendingStops block above) instead of silently dropping
    // it. Still returns false: nothing was live-terminated here.
    //
    // Only USER-initiated stops (abort:true) defer. failChat's transport
    // terminals (abort:false) fire from orchestrator/lifecycle error paths
    // while the pending flag is still up — deferring those would let a dying
    // turn's failChat kill a concurrent second turn on the same session.
    // With no registered entry there is nothing to fail; dropping is correct.
    if (opts.abort && hasChatHandlerPending(sessionId)) recordPendingStop(sessionId, opts);
    return false;
  }

  if (opts.abort) {
    chat.abortController.abort();
    void releaseTurnLockSafe(sessionId);
    void abortActiveSelfEditSafe(sessionId);
  }

  // CT-5: buffer the terminal events, don't just broadcast them. The replay
  // buffer is what a late subscriber (reload, reconnect) receives; without
  // error/done in it, a stopped-then-abandoned session replays bare stream
  // deltas with no terminal → phantom "streaming" bubble.
  if (opts.errorMessage) {
    const errorEvent: ServerEvent = { type: "error", message: opts.errorMessage };
    chat.events.push(errorEvent);
    broadcastToSession(sessionId, errorEvent);
  }
  const doneEvent: ServerEvent = {
    type: "done",
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
  chat.events.push(doneEvent);
  broadcastToSession(sessionId, doneEvent);
  chat.done = true;
  // CT-5: schedule the sweep, mirroring manager.onEvent's natural-done path,
  // so a stopped chat's ActiveChat + up-to-500-event buffer don't leak
  // forever. Identity-guarded: if a NEW chat re-registered this sessionId in
  // the meantime, leave it alone. (Natural done can't double-schedule — the
  // manager's onEvent drops all events once chat.done is set.)
  const sweep = setTimeout(() => {
    if (activeChats.get(sessionId) === chat) {
      activeChats.delete(sessionId);
      broadcastActiveChats();
    }
  }, CHAT_SWEEP_DELAY_MS);
  sweep.unref();
  broadcastActiveChats();
  return true;
}

async function releaseTurnLockSafe(sessionId: string): Promise<void> {
  try {
    const { abortTurn, releaseTurn } = await import("../session/turn-lock.js");
    abortTurn(sessionId);
    releaseTurn(sessionId);
  } catch {
    // best-effort: lock release failures don't change terminate semantics
  }
}

// Kill the live self_edit sandbox subprocesses immediately on user stop.
// Without this, abort propagates only through the canonical-loop signal and
// gets picked up at the next sandbox gate hop — leaving the chat marked done
// while claude -p keeps running for minutes inside the worktree.
async function abortActiveSelfEditSafe(sessionId: string): Promise<void> {
  try {
    const { abortActiveSelfEdit } = await import("../self-edit/session-lock.js");
    abortActiveSelfEdit(sessionId);
  } catch {
    // best-effort: lock module unreachable doesn't change terminate semantics
  }
}
