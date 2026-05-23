/**
 * Inject queue — Step 4 of JARVIS-mode. Per-session FIFO of user
 * messages submitted DURING an in-flight agent turn. The chat-ws
 * handler enqueues; the interjectDrainMiddleware drains at the start
 * of each iteration so the agent sees the user's mid-turn input on its
 * very next iteration.
 *
 * This bypasses the turn-lock entirely — the lock guards "start a NEW
 * turn for this session," but inject is "tack onto the EXISTING turn."
 * The user can keep typing during a multi-tool-loop and each message
 * lands inline.
 *
 * Each queued item carries an ID so the client can correlate the
 * `inject_queued` echo with the eventual `inject_consumed` event and
 * lift its "queued" visual state off the corresponding bubble.
 */

import { randomUUID } from "node:crypto";

export interface InjectItem { id: string; text: string }

const queues = new Map<string, InjectItem[]>();

export function pushInject(sessionId: string, message: string, injectId?: string): string {
  const id = injectId || randomUUID();
  if (!sessionId || !message) return id;
  let q = queues.get(sessionId);
  if (!q) { q = []; queues.set(sessionId, q); }
  q.push({ id, text: message });
  return id;
}

export function drainInjects(sessionId: string): InjectItem[] {
  const q = queues.get(sessionId);
  if (!q || q.length === 0) return [];
  const out = q.slice();
  q.length = 0;
  return out;
}

export function hasInjects(sessionId: string): boolean {
  const q = queues.get(sessionId);
  return !!(q && q.length > 0);
}

/** Test-only / shutdown cleanup. */
export function _resetInjectQueues(): void {
  queues.clear();
}
