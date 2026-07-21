/**
 * Session bridge — session-to-op binding for canonical-loop ops.
 *
 * Tracks which chat session submitted which op so completion events and
 * progress updates can route back to the originating session. Lifecycle
 * events themselves are translated by
 * src/canonical-loop/session-bridge-observer.ts — this module owns the
 * map plumbing only.
 */

import type { ServerEvent } from "../types.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

import { createLogger } from "../logger.js";
const logger = createLogger("workers.session-bridge");

const opSession = new Map<string, string>();
const sessionOps = new Map<string, Set<string>>();
const opTask = new Map<string, string>();

/**
 * Per-session count of chat handlers that have been invoked but haven't yet
 * created their canonical op. Closes the inject-race window where:
 *   T+0    client sends `chat` WS msg
 *   T+1ms  client sets local store status='streaming' (eager)
 *   T+200  user types inject, client sends inject WS msg
 *   T+205  server inject handler sees liveOps=[] (op not created yet from
 *          the chat handler's ~30-200ms prep) → routes as fresh turn →
 *          broadcasts inject_consumed → inject text is lost.
 *
 * lifecycle.ts:wireWsChat brackets its runChatTurn call with markChatHandlerPending
 * / clearChatHandlerPending (try/finally). The inject handler treats pending as
 * "live" for the routing decision — pushes to the queue, where
 * drainInjectsIntoTurn at the top of driveTurn picks it up.
 *
 * Count (not boolean) so concurrent chat handlers for the same session
 * don't clobber each other's pending state.
 */
const pendingChatHandlers = new Map<string, number>();

let broadcaster: ((sessionId: string, event: ServerEvent) => void) | null = null;
let relayWriter: ((sessionId: string, event: ServerEvent) => void) | null = null;
let persister: ((sessionId: string, content: string) => void) | null = null;
let initialized = false;

export function initSessionBridge(): void {
  if (initialized) return;
  initialized = true;
  logger.info("[session-bridge] initialized");
}

export function setSessionBroadcaster(fn: (sessionId: string, event: ServerEvent) => void): void {
  broadcaster = fn;
}

/** Process-worker-only durable output seam. Failure must reach the worker. */
export function setSessionRelayWriter(
  fn: ((sessionId: string, event: ServerEvent) => void) | null,
): void {
  relayWriter = fn;
}

export function broadcastToSession(sessionId: string, event: ServerEvent): void {
  if (relayWriter && sessionId) {
    relayWriter(sessionId, event);
    return;
  }
  if (!broadcaster || !sessionId) return;
  try {
    broadcaster(sessionId, event);
  } catch (e) {
    logger.warn(`[session-bridge] broadcastToSession threw: ${(e as Error).message}`);
  }
}

export function getSessionForOp(opId: string): string | undefined {
  return opSession.get(opId);
}

export function getTaskForOp(opId: string): string | undefined {
  return opTask.get(opId);
}

export function setSessionPersister(fn: (sessionId: string, content: string) => void): void {
  persister = fn;
}

export function getSessionPersister(): ((sessionId: string, content: string) => void) | null {
  return persister;
}

// Reads the originating session's message history so a delegated op can be
// seeded with the recent conversation (context relay). Injected at boot from
// the server's session store — the ops layer never imports it directly.
let sessionMessageReader: ((sessionId: string) => ChatCompletionMessageParam[]) | null = null;

export function setSessionMessageReader(fn: (sessionId: string) => ChatCompletionMessageParam[]): void {
  sessionMessageReader = fn;
}

/**
 * Recent messages from the session that submitted an op, for context relay.
 * Returns [] when no reader is wired or the session is unknown — a worker
 * starting blind is the failure this exists to prevent, but it must never
 * throw and break op submission.
 */
export function readRecentSessionMessages(sessionId: string): ChatCompletionMessageParam[] {
  if (!sessionMessageReader || !sessionId) return [];
  try {
    return sessionMessageReader(sessionId) || [];
  } catch (e) {
    logger.warn(`[session-bridge] session message read threw: ${(e as Error).message}`);
    return [];
  }
}

// Hands a line to the active voice session for a sessionId so the agent speaks
// it proactively (op finished / worker needs input). Injected at boot from the
// voice layer's proactive registry — the ops layer never imports voice.
let voiceProactiveSpeaker: ((sessionId: string, text: string) => boolean) | null = null;

export function setVoiceProactiveSpeaker(fn: (sessionId: string, text: string) => boolean): void {
  voiceProactiveSpeaker = fn;
}

/**
 * Speak a line into the active voice session for `sessionId`, if one is
 * connected. Returns true when voice took it (so the caller can skip / dedupe
 * the chat-only path), false when there's no live voice session.
 */
export function proactiveSpeakToSession(sessionId: string, text: string): boolean {
  if (!voiceProactiveSpeaker || !sessionId || !text) return false;
  try {
    return voiceProactiveSpeaker(sessionId, text);
  } catch (e) {
    logger.warn(`[session-bridge] proactive speak threw: ${(e as Error).message}`);
    return false;
  }
}

export function trackOpForSession(opId: string, sessionId: string, task?: string): void {
  if (!sessionId) return;
  opSession.set(opId, sessionId);
  if (task) opTask.set(opId, task);
  let set = sessionOps.get(sessionId);
  if (!set) { set = new Set(); sessionOps.set(sessionId, set); }
  set.add(opId);
}

export function listOpsForSession(sessionId: string): string[] {
  const set = sessionOps.get(sessionId);
  return set ? [...set] : [];
}

export function getOpTask(opId: string): string | undefined {
  return opTask.get(opId);
}

/**
 * Drop an op from the session map. Called by the canonical-loop
 * session-bridge-observer once an op reaches a terminal state so
 * `listOpsForSession` returns only currently-live ops. Without the drop,
 * completed ops bleed into the system-prompt augmentation that detects
 * "active background workers" and poisons every subsequent turn.
 */
export function markChatHandlerPending(sessionId: string): void {
  if (!sessionId) return;
  pendingChatHandlers.set(sessionId, (pendingChatHandlers.get(sessionId) || 0) + 1);
}

export function clearChatHandlerPending(sessionId: string): void {
  if (!sessionId) return;
  const n = (pendingChatHandlers.get(sessionId) || 0) - 1;
  if (n <= 0) pendingChatHandlers.delete(sessionId);
  else pendingChatHandlers.set(sessionId, n);
}

export function hasChatHandlerPending(sessionId: string): boolean {
  return (pendingChatHandlers.get(sessionId) || 0) > 0;
}

export function releaseOpFromSession(opId: string): void {
  const sessionId = opSession.get(opId);
  if (!sessionId) return;
  opSession.delete(opId);
  const set = sessionOps.get(sessionId);
  if (set) {
    set.delete(opId);
    if (set.size === 0) sessionOps.delete(sessionId);
  }
  opTask.delete(opId);
}
