/**
 * Sending a chat a message from the app, not the user, so its agent takes a
 * turn on something that happened while nobody typed: a background op ended
 * (ops/op-report-wake.ts), a verification check the user completed
 * (tools/browser-tools/human-check-handoff.ts).
 *
 * A chat only runs when it gets a message. The turn runs through the chat
 * handler a typed message uses, so it streams to anyone viewing that chat and
 * passes every gate. A turn already running is waited out. The message is
 * composed when it is sent, not when it was asked for, so a caller can say
 * "nothing to send any more" (null) when a user turn already covered it.
 */
import { getChatHandler } from "./chat-handler.js";
import { hasActiveTurn, onTurnRelease } from "../session/turn-lock.js";
import { isSyntheticSessionId } from "../memory/synthetic-sessions.js";
import { createLogger } from "../logger.js";

const logger = createLogger("chat-ws.app-message");

/** A chat with a user behind it: never a background job's session (dream-,
 *  cron-, mail-watch-, ...), a sub-agent's, or a worker op's own, which its
 *  parent hears of through op_wait / op_status. Only these get app messages. */
export function isUserChat(sessionId: string): boolean {
  return !!sessionId && !isSyntheticSessionId(sessionId) && !sessionId.startsWith("agent-") && !sessionId.startsWith("op_") && sessionId !== "default";
}

/** Compose and send once `sessionId` has no turn running. Returns false when
 *  there is no chat handler (no server), so the caller can fall back. */
export function sendAppMessageWhenIdle(sessionId: string, compose: () => string | null): boolean {
  const handler = getChatHandler();
  if (!handler) return false;
  if (hasActiveTurn(sessionId)) {
    onTurnRelease(sessionId, () => { sendAppMessageWhenIdle(sessionId, compose); });
    return true;
  }
  const message = compose();
  if (message === null) return true;
  void Promise.resolve(handler(sessionId, message, [], { channel: "web" }))
    .catch((e) => logger.warn(`app message to ${sessionId} failed: ${(e as Error).message}`));
  return true;
}
