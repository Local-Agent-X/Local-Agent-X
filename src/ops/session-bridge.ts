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

import { createLogger } from "../logger.js";
const logger = createLogger("workers.session-bridge");

const opSession = new Map<string, string>();
const sessionOps = new Map<string, Set<string>>();
const opTask = new Map<string, string>();

let broadcaster: ((sessionId: string, event: ServerEvent) => void) | null = null;
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

export function broadcastToSession(sessionId: string, event: ServerEvent): void {
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
