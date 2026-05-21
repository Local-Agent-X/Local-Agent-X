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
} from "./state.js";

const logger = createLogger("chat-ws");

export interface ChatWsManager {
  startChat(sessionId: string): { abort: AbortController; onEvent: (event: ServerEvent) => void };
  getAbortSignal(sessionId: string): AbortSignal | undefined;
  stopChat(sessionId: string): boolean;
  getActiveChats(): string[];
  failChat(sessionId: string, errorMessage: string): void;
  emit(sessionId: string, event: ServerEvent): void;
  onChat(handler: ChatHandler): void;
}

export function buildManager(): ChatWsManager {
  return {
    /** Register an active chat. Called when /api/chat starts processing. */
    startChat(sessionId: string) {
      const abortController = new AbortController();
      const chat: ActiveChat = {
        sessionId,
        events: [],
        abortController,
        startedAt: Date.now(),
        done: false,
      };
      activeChats.set(sessionId, chat);
      broadcastActiveChats();

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

          chat.events.push(event);
          if (chat.events.length > 500) {
            chat.events = chat.events.slice(-400);
          }

          broadcastToSession(sessionId, event);

          // Mark done only on real completion — non-terminal errors
          // should not end the chat.
          if (event.type === "done") {
            chat.done = true;
            setTimeout(() => {
              activeChats.delete(sessionId);
              broadcastActiveChats();
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
      const chat = activeChats.get(sessionId);
      if (!chat || chat.done) return false;
      chat.abortController.abort();
      // Release the turn lock so the next message isn't rejected with
      // "previous request still running". Fire-and-forget — if it
      // throws we still want stop to return true.
      void (async () => {
        try {
          const { abortTurn, releaseTurn } = await import("../session-turn-lock.js");
          abortTurn(sessionId);
          releaseTurn(sessionId);
        } catch (e) {
          logger.warn(`[stopChat] turn-lock release failed: ${(e as Error).message}`);
        }
      })();
      broadcastToSession(sessionId, { type: "error", message: "Stopped by user" });
      broadcastToSession(sessionId, { type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
      chat.done = true;
      broadcastActiveChats();
      return true;
    },

    getActiveChats(): string[] {
      return [...activeChats.keys()].filter(id => !activeChats.get(id)!.done);
    },

    /** Force-terminate a chat with an error reason. Used by
     *  transport-level error handlers (e.g. wireWsChat self-loop fetch
     *  failure) so the WS client gets a terminal signal instead of
     *  waiting for the 5-minute cleanup timer. */
    failChat(sessionId: string, errorMessage: string): void {
      const chat = activeChats.get(sessionId);
      if (!chat || chat.done) return;
      broadcastToSession(sessionId, { type: "error", message: errorMessage });
      broadcastToSession(sessionId, { type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
      chat.done = true;
      broadcastActiveChats();
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
