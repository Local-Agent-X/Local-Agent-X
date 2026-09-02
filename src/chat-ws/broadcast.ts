// Fan-out + termination over the shared chat-ws state. Split out of
// ./state.ts (2026-09-01, 400-LOC gate): state.ts keeps the data
// (activeChats, clients, run accumulators); this module owns everything
// that SENDS — per-session event fan-out, the active_chats listing,
// broadcast-to-all — plus terminateChat, which lives here because it both
// drives the terminal broadcasts and feeds the CT-4 pending-stop drain
// that broadcastActiveChats performs.

import type { ServerEvent } from "../types.js";
import { hasChatHandlerPending } from "../ops/session-bridge.js";
import { isHiddenFromChatLists } from "../memory/synthetic-sessions.js";
import { notifySessionEventObservers } from "./session-event-observers.js";
import { activeChats, clients } from "./state.js";

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

// Headless sessions must never reach a browser (their frames would render
// into user chat). eval_ (routes/chat.ts randomId("eval")) is the LIVE case:
// it calls startChat. skill-review-/dream- (background-jobs) are guards only
// — they never startChat and nothing subscribes. Local tuple: skill-review.ts
// cycles via canonical-loop. Exported as the ONE headless-session predicate
// for every chat-facing surface: broadcastToSession here and ops/idle-nudge
// (a background op's completion must never nudge into user chat). Consumers
// import this — never re-declare the prefix list.
//
// Deliberately NARROWER than isHiddenFromChatLists
// (memory/synthetic-sessions.ts): cron- and ide- are absent HERE on purpose.
// A cron job is a USER-SCHEDULED task — its failure must still nudge/notify
// (test/idle-nudge-headless.test.ts pins it) — and ide- chats are live user
// chats over this socket. "Hidden from chat lists" (UI concern, cron
// included) and "never interrupts the user" (this list) are separate
// concerns — do not merge them.
const HEADLESS_SESSION_PREFIXES = ["eval_", "skill-review-", "dream-"] as const;
export function isHeadlessSession(sessionId: string): boolean {
  return HEADLESS_SESSION_PREFIXES.some(p => sessionId.startsWith(p));
}

// Backpressure ceiling for droppable delta frames (2026-07-13 audit I2). A
// hung/slow client (frozen tab, saturated mobile link) never drains its
// socket, so ws.send at token rate buffers unboundedly in this process.
// Above this per-socket threshold we skip DELTA-shaped stream/reasoning
// frames only. Replace, terminal (done/error/stopped), and tool events are
// NEVER dropped, so state convergence is preserved. Recovery honesty: a
// client that reconnects/re-subscribes gets the full text via the replay's
// coalesced replace (built from the ActiveChat accumulators). A client that
// is merely SLOW and later drains without reconnecting keeps a hole in the
// live bubble until reload — the 20s op_heartbeat keeps the stuck-stream
// watchdog quiet, so no automatic replay fires for it. Accepted trade:
// buffering >1MB at token rate is pathological, and bounding server memory
// wins; server-side history stays complete regardless.
const BACKPRESSURE_MAX_BUFFERED = 1_000_000;

export function broadcastToSession(sessionId: string, event: ServerEvent): void {
  if (isHeadlessSession(sessionId)) return;
  notifySessionEventObservers(sessionId, event);
  // Delta-shaped stream/reasoning only — the sole event class whose loss the
  // replay replace fully repairs. Everything else must always be sent.
  const droppable =
    (event.type === "stream" || event.type === "reasoning") && !("replace" in event);
  const payload = JSON.stringify({ type: "event", sessionId, event });
  for (const [ws, subs] of clients) {
    if (subs.has(sessionId) && ws.readyState === 1 /* OPEN */) {
      if (droppable && ws.bufferedAmount > BACKPRESSURE_MAX_BUFFERED) continue;
      ws.send(payload);
    }
  }
}

/** The ONE definition of the active_chats listing: live turns minus every
 *  session that must not appear as a chat row. isHiddenFromChatLists is a
 *  strict superset of the headless tuple above (pinned in
 *  test/chat-ws-headless-filter.test.ts) and additionally hides cron- —
 *  scheduled runs surface in the tasks view, and any id listed here makes
 *  the browser mint a sidebar row for it (chat-stream-store-approvals.js
 *  setActiveSidebarSet → ensure()). cron- stays UNfiltered in
 *  broadcastToSession above: hiding the row must not mute the run's events
 *  or its failure nudge. Consumed by broadcastActiveChats AND
 *  connection-setup's on-connect snapshot — the snapshot used to send the
 *  raw map, leaking headless/cron ids to every fresh connection. */
export function listActiveChatIds(): string[] {
  return [...activeChats.keys()].filter(
    id => !activeChats.get(id)!.done && !isHiddenFromChatLists(id),
  );
}

export function broadcastActiveChats(): void {
  // startChat calls this synchronously right after registering an ActiveChat,
  // making it the earliest state-side hook to honor a stop that raced the
  // registration (CT-4).
  drainPendingStops();
  const payload = JSON.stringify({ type: "active_chats", sessionIds: listActiveChatIds() });
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
