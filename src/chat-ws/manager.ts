// Public manager API surfaced by setupChatWebSocket. Owns per-chat
// lifecycle: startChat (register an in-flight chat), stopChat (abort +
// release), failChat (terminal error path), emit (one-off event push),
// onChat (register the message handler).

import type { ServerEvent } from "../types.js";
import { createLogger } from "../logger.js";
import {
  activeChats,
  type ActiveChat,
  type ChatHandler,
  broadcastActiveChats,
  broadcastToSession,
  setChatHandler,
  terminateChat,
} from "./state.js";

const logger = createLogger("chat-ws");

// Keepalive cadence for live turns. The client's stuck-stream watchdog
// (public/js/chat-ws.js) fires reconnect_op after 60s without events, so a
// single long tool call (a build, npm install) used to trigger needless full
// replays. 20s keeps the client's activity clock fresh with 3x margin under
// that 60s threshold.
const HEARTBEAT_INTERVAL_MS = 20_000;

// Belt-and-suspenders lifetime bound on the keepalive (2026-07-13 audit,
// skeptic finding): if an ActiveChat entry leaks — an error path where `done`
// never lands (the known one: emitTurnError bypassing onEvent; its root fix
// lives in run-chat-turn's error path) — an immortal heartbeat would keep the
// client's activity clock fresh forever and defeat the watchdog's
// reconnect_op recovery of that session's phantom stream. 4h is generously
// above any plausible turn, including multi-hour agentic builds, so healthy
// turns never hit it; any leaked entry stops masking itself within one
// interval past the cap.
const HEARTBEAT_MAX_LIFETIME_MS = 4 * 60 * 60 * 1000;

export interface ChatWsManager {
  startChat(sessionId: string): { abort: AbortController; onEvent: (event: ServerEvent) => void };
  getAbortSignal(sessionId: string): AbortSignal | undefined;
  stopChat(sessionId: string): boolean;
  getActiveChats(): string[];
  failChat(sessionId: string, errorMessage: string): void;
  failChatIfCurrent(sessionId: string, token: AbortController, errorMessage: string): boolean;
  emit(sessionId: string, event: ServerEvent): void;
  onChat(handler: ChatHandler): void;
}

export function buildManager(): ChatWsManager {
  return {
    /** Register an active chat. Called when /api/chat starts processing. */
    startChat(sessionId: string) {
      // 2026-07-13 audit F8 + skeptic finding: do NOT terminate a live entry
      // here. The caller already holds this session's turn lock — the
      // lock-then-startChat invariant (run-chat-turn/orchestrator.ts:162) —
      // and terminateChat's abort path releases that lock by sessionId with
      // no writer-identity check, so terminating would kill the NEW turn's
      // own lock microtasks after it registers. delegation-handoff.ts:134
      // also legitimately calls startChat while a committing turn is still
      // live; aborting (or even just marking that entry done — its onEvent
      // guard would then drop the committing turn's remaining broadcasts)
      // regresses that path. So overwrite as before, but log it; the
      // identity-guarded sweeps below and in state.ts keep the old timers
      // from reaping the new entry.
      const existing = activeChats.get(sessionId);
      if (existing && !existing.done) {
        logger.warn(`startChat: overwriting live activeChats entry for session ${sessionId}`);
      }

      const abortController = new AbortController();
      const chat: ActiveChat = {
        sessionId,
        events: [],
        streamText: "",
        sawStream: false,
        toolsSinceText: false,
        abortController,
        startedAt: Date.now(),
        done: false,
      };
      activeChats.set(sessionId, chat);
      broadcastActiveChats();

      // Heartbeat: keep the client's per-op activity clock fresh through
      // long silent tool calls. Broadcast-only — never pushed into
      // chat.events (replay noise) and never routed through onEvent. The
      // identity check makes the interval self-cleaning across every exit
      // path: natural done, terminateChat (state.ts marks done), and
      // overwrite by a successor startChat — no cross-module wiring needed.
      // The lifetime cap backstops entry-leak paths where done never lands.
      const heartbeat = setInterval(() => {
        if (
          chat.done ||
          activeChats.get(sessionId) !== chat ||
          Date.now() - chat.startedAt > HEARTBEAT_MAX_LIFETIME_MS
        ) {
          clearInterval(heartbeat);
          return;
        }
        broadcastToSession(sessionId, { type: "op_heartbeat" });
      }, HEARTBEAT_INTERVAL_MS);
      // Never hold the process open for a keepalive.
      heartbeat.unref?.();

      return {
        abort: abortController,
        onEvent(event: ServerEvent) {
          // If this turn was already stopped (user pressed Stop, or `done`
          // already emitted), drop any further events. Provider streams
          // can keep flushing buffered tokens for a brief window after
          // the abort signal — without this guard those stale deltas
          // leak into the next turn on the same session and overwrite
          // the new response.
          if (chat.done) return;

          if (event.type === "stream") {
            // Fold stream text into the ActiveChat accumulator instead of
            // buffering the events. Buffered per-token deltas used to blow
            // through the 500/400 trim below on any long turn, so a mid-turn
            // reconnect replayed only the TAIL as a `replace` and clobbered
            // the client's fuller partial (trim-truncation bug, 2026-07-13
            // audit — see replayBufferedEvents in state.ts).
            chat.sawStream = true; // gates the replay's replace frame — even for text:""
            if ("replace" in event) {
              chat.streamText = event.text;
              chat.toolsSinceText = false;
            } else {
              // Mirror the client store: a tool card since the last text
              // means the next delta starts a new paragraph
              // (chat-stream-store.js applyEvent).
              if (chat.toolsSinceText && chat.streamText && !chat.streamText.endsWith("\n")) {
                chat.streamText += "\n\n";
              }
              chat.streamText += event.delta;
              chat.toolsSinceText = false;
            }
          } else {
            if (event.type === "tool_start" || event.type === "tool_end") {
              chat.toolsSinceText = true;
            }
            chat.events.push(event);
            // Backstop only, now that stream deltas never land here — the
            // non-stream event list stays small, and trimming it can no
            // longer truncate the replayed text.
            if (chat.events.length > 500) {
              chat.events = chat.events.slice(-400);
            }
          }

          broadcastToSession(sessionId, event);

          // Mark done only on real completion — non-terminal errors
          // should not end the chat.
          if (event.type === "done") {
            chat.done = true;
            // Stop the keepalive promptly (the interval's own done-check
            // would also catch it next tick; clearInterval is idempotent).
            clearInterval(heartbeat);
            // Identity-guarded like terminateChat's sweep (state.ts): if a
            // NEW chat re-registered this sessionId in the meantime, a stale
            // sweep must not reap the successor's entry (2026-07-13 audit, F8).
            setTimeout(() => {
              if (activeChats.get(sessionId) === chat) {
                activeChats.delete(sessionId);
                broadcastActiveChats();
              }
            }, 5 * 60 * 1000);
            broadcastActiveChats();
          }
        },
      };
    },

    getAbortSignal(sessionId: string): AbortSignal | undefined {
      return activeChats.get(sessionId)?.abortController.signal;
    },

    /** Stop a chat by session ID (used by the HTTP fallback when WS is
     *  unavailable). Returns true if the chat was active and aborted. */
    stopChat(sessionId: string): boolean {
      return terminateChat(sessionId, { abort: true, errorMessage: "Stopped by user" });
    },

    getActiveChats(): string[] {
      return [...activeChats.keys()].filter(id => !activeChats.get(id)!.done);
    },

    /** Force-terminate a chat with an error reason. Used by transport-level
     *  error handlers (e.g. wireWsChat catch block) so the WS client gets a
     *  terminal signal instead of waiting for the 5-minute cleanup timer.
     *  Skips the abort path because the orchestrator's catch already finished
     *  its side of the turn. */
    failChat(sessionId: string, errorMessage: string): void {
      terminateChat(sessionId, { abort: false, errorMessage });
    },

    /** Identity-guarded failChat for a turn's OWN entry (2026-07-13 audit
     *  skeptic round 2). A plain failChat terminates whatever entry CURRENTLY
     *  owns the sessionId — reachable clobber: turn T1 wedges (provider
     *  ignores abort >5s), T2's tryAcquireOrReplace force-releases the lock
     *  and its startChat overwrites the map entry; when T1 finally un-wedges
     *  and its error path fires a terminal failChat, it would mark T2's LIVE
     *  entry done — T2's remaining events all drop on the onEvent done-guard,
     *  Stop no-ops, and the client sees `done` mid-stream. The token is the
     *  AbortController startChat minted for the turn (returned as `.abort`
     *  and stored on the entry), so `entry.abortController === token` proves
     *  the caller still owns the current entry. Returns true iff it
     *  terminated; false when the entry is gone, already done, or a
     *  successor's. */
    failChatIfCurrent(sessionId: string, token: AbortController, errorMessage: string): boolean {
      const chat = activeChats.get(sessionId);
      if (!chat || chat.done || chat.abortController !== token) return false;
      return terminateChat(sessionId, { abort: false, errorMessage });
    },

    /** Push a one-off event to WS subscribers of `sessionId` outside
     *  the per-chat onEvent channel (which only exists between
     *  startChat and `done`). Used for pre-turn telemetry like
     *  context_status that the old code path emitted via emitSse only
     *  — WS clients never saw it because emitSse is null on the WS
     *  transport (see run-chat-turn.ts). */
    emit(sessionId: string, event: ServerEvent): void {
      broadcastToSession(sessionId, event);
    },

    onChat(handler: ChatHandler) {
      setChatHandler(handler);
    },
  };
}
