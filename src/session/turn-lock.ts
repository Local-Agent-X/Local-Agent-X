// Per-session turn lock.
//
// Before this existed, a second message for a session whose previous turn
// was still running would spawn a SECOND parallel agent loop. Both loops
// read session state at their start, both wrote at their end, last writer
// won — and the second loop had no idea the first was in flight, so the
// agent would answer "nothing is running" while 13 tool calls were live.
//
// This module owns the single-turn-per-session invariant. It's in-memory
// only; a server restart empties the registry cleanly (no stuck locks).
//
// Policy at the chat route:
//   - No active turn → acquire + run
//   - Active turn hasn't made a committing tool call yet → abort it, acquire, run
//   - Active turn HAS made a committing tool call → 409 with turn details; caller
//     decides whether to cancel (via abortTurn) or wait
//
// `markIteration` is called from inside each agent loop at iteration start so
// the registry reflects live progress (iteration count, last tool, committing
// status). That's what the 409 response exposes and what session_status reads.

import { isCommittingTool } from "../committing-tool-check.js";

export interface ActiveTurn {
  sessionId: string;
  abortController: AbortController;
  startedAt: number;
  iteration: number;
  toolsCalled: string[];
  lastToolName?: string;
  hasCommitted: boolean;
  /** Set when acquireTurn was called with an explicit label (for logging) */
  origin?: string;
  /** Callbacks to run when the turn is released/aborted. Used by the
   *  heartbeat ticker (and anything else with turn-scoped resources) so
   *  callers don't need to remember to stop them in every return path. */
  cleanupCallbacks: Array<() => void>;
  /** Resolves when this turn has fully finished — runAgent returned,
   *  session.messages has been persisted, and releaseTurn has been called.
   *  Lets the next turn await the prior turn's commit before reading
   *  session state, fixing the read-stale-history race. */
  completion: Promise<void>;
  /** Internal: invoked by releaseTurn to settle `completion`. */
  resolveCompletion: () => void;
}

export interface ActiveTurnSnapshot {
  sessionId: string;
  startedAt: number;
  elapsedMs: number;
  iteration: number;
  toolsCalled: string[];
  lastToolName?: string;
  hasCommitted: boolean;
}

class TurnRegistry {
  private turns = new Map<string, ActiveTurn>();

  /** Try to claim the session's turn slot. Returns true if acquired. */
  acquireTurn(sessionId: string, abortController: AbortController, origin?: string): boolean {
    if (this.turns.has(sessionId)) return false;
    let resolveCompletion: () => void = () => {};
    const completion = new Promise<void>(resolve => { resolveCompletion = resolve; });
    this.turns.set(sessionId, {
      sessionId,
      abortController,
      startedAt: Date.now(),
      iteration: 0,
      toolsCalled: [],
      hasCommitted: false,
      origin,
      cleanupCallbacks: [],
      completion,
      resolveCompletion,
    });
    return true;
  }

  /** Register a callback to run when this session's turn releases/aborts.
   *  No-op if no active turn. Stored in insertion order; fired in reverse. */
  onRelease(sessionId: string, cb: () => void): void {
    const t = this.turns.get(sessionId);
    if (!t) return;
    t.cleanupCallbacks.push(cb);
  }

  /** Run all cleanup callbacks (reverse insertion order) for a session. */
  private runCleanups(t: ActiveTurn): void {
    for (let i = t.cleanupCallbacks.length - 1; i >= 0; i--) {
      try { t.cleanupCallbacks[i](); } catch { /* never throw from cleanup */ }
    }
  }

  /** Read the active turn snapshot for a session, or null. */
  getActiveTurn(sessionId: string): ActiveTurnSnapshot | null {
    const t = this.turns.get(sessionId);
    if (!t) return null;
    return {
      sessionId: t.sessionId,
      startedAt: t.startedAt,
      elapsedMs: Date.now() - t.startedAt,
      iteration: t.iteration,
      toolsCalled: [...t.toolsCalled],
      lastToolName: t.lastToolName,
      hasCommitted: t.hasCommitted,
    };
  }

  /** Update the active turn's iteration + tool-call history. Called from
   *  inside each agent loop iteration. No-op if no active turn for the
   *  session (e.g. the loop aborted but cleanup hasn't fired yet). */
  markIteration(sessionId: string, toolNames: string[]): void {
    const t = this.turns.get(sessionId);
    if (!t) return;
    t.iteration += 1;
    for (const name of toolNames) {
      t.toolsCalled.push(name);
      t.lastToolName = name;
      if (isCommittingTool(name)) t.hasCommitted = true;
    }
  }

  /** Release the turn slot. Idempotent — safe to call multiple times. */
  releaseTurn(sessionId: string): void {
    const t = this.turns.get(sessionId);
    if (!t) return;
    this.runCleanups(t);
    this.turns.delete(sessionId);
    t.resolveCompletion();
  }

  /** External cancel — aborts the turn's controller. Does NOT delete the
   *  registry entry: the aborted turn's handler still runs through its
   *  finally block, persists session.messages, and calls releaseTurn itself.
   *  That's how the next turn awaits the commit before proceeding. */
  abortTurn(sessionId: string): boolean {
    const t = this.turns.get(sessionId);
    if (!t) return false;
    try { t.abortController.abort(); } catch { /* already aborted */ }
    return true;
  }

  /** Get the completion promise for the active turn, or null. */
  getCompletion(sessionId: string): Promise<void> | null {
    return this.turns.get(sessionId)?.completion ?? null;
  }

  /** Convenience: list all active turns (for debug/admin UI). */
  listActive(): ActiveTurnSnapshot[] {
    return Array.from(this.turns.keys())
      .map(id => this.getActiveTurn(id))
      .filter((t): t is ActiveTurnSnapshot => t !== null);
  }
}

// Module-level singleton
const registry = new TurnRegistry();

export function getTurnRegistry(): TurnRegistry {
  return registry;
}

// ── Convenience helpers ───────────────────────────────────────────────────
// Most callers only need these.

export function acquireTurn(sessionId: string, abortController: AbortController, origin?: string): boolean {
  return registry.acquireTurn(sessionId, abortController, origin);
}

export function getActiveTurn(sessionId: string): ActiveTurnSnapshot | null {
  return registry.getActiveTurn(sessionId);
}

export function markIteration(sessionId: string | undefined, toolNames: string[]): void {
  if (!sessionId) return;
  registry.markIteration(sessionId, toolNames);
}

export function releaseTurn(sessionId: string | undefined): void {
  if (!sessionId) return;
  registry.releaseTurn(sessionId);
}

export function onTurnRelease(sessionId: string | undefined, cb: () => void): void {
  if (!sessionId) return;
  registry.onRelease(sessionId, cb);
}

export function abortTurn(sessionId: string): boolean {
  return registry.abortTurn(sessionId);
}

export interface AcquireDecision {
  allowed: boolean;
  reason: "no-active" | "aborted-non-committing" | "refused-committing";
  previous?: ActiveTurnSnapshot;
}

/**
 * High-level: decide whether a new message for this session can proceed.
 * Aborts the previous turn if it's safe to replace; refuses with details if
 * the previous turn has already made a committing tool call.
 *
 * When a prior turn is aborted, this awaits its `completion` promise before
 * acquiring — that promise resolves only after the prior turn's handler has
 * persisted session.messages. Without this wait, the new turn would read
 * stale session state and the agent would forget its own previous reply.
 */
export async function tryAcquireOrReplace(
  sessionId: string,
  newAbortController: AbortController,
  origin?: string,
): Promise<AcquireDecision> {
  const existing = registry.getActiveTurn(sessionId);
  if (!existing) {
    registry.acquireTurn(sessionId, newAbortController, origin);
    return { allowed: true, reason: "no-active" };
  }
  if (existing.hasCommitted) {
    return { allowed: false, reason: "refused-committing", previous: existing };
  }
  // Non-committing: abort the prior turn, then wait for its handler to finish
  // its commit (session.messages write + saveSession + releaseTurn). Only
  // after that completion is it safe to acquire and read fresh session state.
  const priorCompletion = registry.getCompletion(sessionId);
  registry.abortTurn(sessionId);
  if (priorCompletion) {
    // Bound the wait so a stuck prior turn can't deadlock us.
    await Promise.race([
      priorCompletion,
      new Promise<void>(resolve => setTimeout(resolve, 5000)),
    ]);
  }
  // If the prior turn never released within the timeout, force-release so
  // the slot can be acquired. This is a safety net for stuck handlers.
  if (registry.getActiveTurn(sessionId)) {
    registry.releaseTurn(sessionId);
  }
  registry.acquireTurn(sessionId, newAbortController, origin);
  return { allowed: true, reason: "aborted-non-committing", previous: existing };
}
