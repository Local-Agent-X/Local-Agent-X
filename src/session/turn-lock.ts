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
//   - Active turn HAS made (or is making) a committing tool call → refused with
//     turn details; the route surfaces them on the live transport and the caller
//     decides whether to cancel (via abortTurn) or wait. Not an HTTP status —
//     routes/chat/run-chat-turn/orchestrator.ts emits a turn error and returns.
//
// Live progress (iteration count, last tool, committing status) is written by
// `beginToolRound`, called once per tool-dispatch round from
// canonical-loop/turn-loop/dispatch-tools.ts BEFORE the tools execute. That is
// the one seam that holds all three things this registry needs: the op id (so a
// delegated background worker, which INHERITS the originating chat session id,
// can be told apart from the user's own chat turn), the tool names, and the
// call args (so the ARG-AWARE committing verdict is available — a name-only
// verdict answers false for http_request/browser/pdf). Marking before execution
// is deliberate: a turn whose payment POST is still in flight must already
// refuse replacement. The caller settles each mark against the dispatch result;
// only a user-DECLINED call, refused before the tool body ran, is settled back
// down (dispatch-tools.ts NEVER_LANDED owns that judgement).
//
// `markIteration` is the name-only form, kept for callers with no result to
// reconcile against; it latches immediately, exactly as it always did.

import { isCommittingTool } from "../committing-tool-check.js";

export interface ActiveTurn {
  sessionId: string;
  abortController: AbortController;
  startedAt: number;
  iteration: number;
  toolsCalled: string[];
  lastToolName?: string;
  /** A committing tool call has COMPLETED (or could have landed). Write-once
   *  for the life of the turn — only releaseTurn clears it, with the turn. */
  hasCommitted: boolean;
  /** Committing tool calls dispatched but not yet settled. Held open across the
   *  whole execution window on purpose: a turn whose payment POST is IN FLIGHT
   *  must already refuse replacement, not only one that has returned. Settled
   *  back down by the handle `beginToolRound` returns — a mark that never
   *  settles would keep the turn off tryAcquireOrReplace's replaceable branch,
   *  and so off its 5s force-release net, for the rest of the turn. */
  committingInFlight: number;
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
  /** A committing tool call has completed OR one is in flight right now. Both
   *  mean the same thing to every consumer — this turn must not be silently
   *  aborted and replaced — so the snapshot merges them. */
  hasCommitted: boolean;
}

/** One call in a dispatch round, with the committing verdict already decided
 *  by the caller. Only dispatch has the args, and only the arg-aware verdict
 *  (committing-tool-check.isCommittingCall) can tell a `pdf` read from a `pdf
 *  create` or an idempotent GET from a charge POST. */
export interface ToolRoundCall {
  name: string;
  committing: boolean;
}

/** Settles the committing marks one dispatch round put in flight. */
export interface ToolRoundHandle {
  /** Settle ONE of this round's committing calls. `committed` false means the
   *  call provably never reached its side effect (policy block, user decline,
   *  reported failure) and so must not latch the session. */
  settle(committed: boolean): void;
  /** Settle every mark this round still holds as NOT committed. Idempotent,
   *  and a no-op once `settle` has accounted for each call — call it on the
   *  throw path so an exception can never strand a mark. */
  abandon(): void;
}

/** Handle for a round that marked nothing (no active turn, or no committing
 *  calls in the round). */
const INERT_ROUND: ToolRoundHandle = { settle: () => {}, abandon: () => {} };

class TurnRegistry {
  private turns = new Map<string, ActiveTurn>();
  /** Monotonic per-session write generation, bumped on every acquire and
   *  NEVER cleared on release: a wedged turn that was force-released (the
   *  tryAcquireOrReplace 5s safety net) can outlive its replacement, so it
   *  must stay identifiable as stale even after the replacement releases. */
  private generations = new Map<string, number>();
  /** Which acquire each turn's abort signal belongs to. Keyed by signal
   *  because the signal already flows everywhere the turn handler does —
   *  it lets persistTurnState ask "am I still the latest writer?" with no
   *  new plumbing. WeakMap so entries die with their controllers. */
  private writerTags = new WeakMap<AbortSignal, { sessionId: string; generation: number }>();

  /** Try to claim the session's turn slot. Returns true if acquired. */
  acquireTurn(sessionId: string, abortController: AbortController, origin?: string): boolean {
    if (this.turns.has(sessionId)) return false;
    const generation = (this.generations.get(sessionId) ?? 0) + 1;
    this.generations.set(sessionId, generation);
    this.writerTags.set(abortController.signal, { sessionId, generation });
    let resolveCompletion: () => void = () => {};
    const completion = new Promise<void>(resolve => { resolveCompletion = resolve; });
    this.turns.set(sessionId, {
      sessionId,
      abortController,
      startedAt: Date.now(),
      iteration: 0,
      toolsCalled: [],
      hasCommitted: false,
      committingInFlight: 0,
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

  /** Is a turn holding this session's slot? The registry is the AUTHORITY on
   *  that question: the slot is claimed before the canonical op exists and
   *  released in the chat orchestrator's finally, so it spans both windows the
   *  ops-layer signals (sessionOps / pendingChatHandlers) leave open. Separate
   *  from getActiveTurn because callers on a hot path want the bit, not a
   *  snapshot allocation. */
  hasActiveTurn(sessionId: string): boolean {
    return this.turns.has(sessionId);
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
      hasCommitted: t.hasCommitted || t.committingInFlight > 0,
    };
  }

  /** Open one tool-dispatch round: bump the iteration, append the tool names,
   *  and put every committing call IN FLIGHT so replacement is refused for the
   *  whole execution window. The returned handle settles those marks against
   *  the dispatch results. No-op (inert handle) if no active turn holds the
   *  session — an agent-runner or delegated op, or a loop that aborted before
   *  cleanup fired. */
  beginToolRound(sessionId: string, calls: ToolRoundCall[]): ToolRoundHandle {
    const t = this.turns.get(sessionId);
    if (!t) return INERT_ROUND;
    t.iteration += 1;
    let unsettled = 0;
    for (const call of calls) {
      t.toolsCalled.push(call.name);
      t.lastToolName = call.name;
      if (call.committing) unsettled += 1;
    }
    if (unsettled === 0) return INERT_ROUND;
    t.committingInFlight += unsettled;
    const settle = (committed: boolean): void => {
      if (unsettled === 0) return;
      unsettled -= 1;
      // The turn this round belongs to may already be gone (user Stop, or a
      // force-release followed by a replacement acquiring the slot). Settling
      // then would credit or debit its SUCCESSOR's counters, so only the
      // still-installed turn is touched.
      if (this.turns.get(sessionId) !== t) return;
      t.committingInFlight -= 1;
      if (committed) t.hasCommitted = true;
    };
    return {
      settle,
      abandon: () => { while (unsettled > 0) settle(false); },
    };
  }

  /** Name-only form of beginToolRound, for callers holding no dispatch result
   *  to reconcile against. Every committing name latches immediately — the
   *  write-once behavior this API has always had. Multi-action tools
   *  (http_request / browser / pdf) answer false at the name-only layer;
   *  callers with args in scope must use beginToolRound with isCommittingCall. */
  markIteration(sessionId: string, toolNames: string[]): void {
    const calls = toolNames.map(name => ({ name, committing: isCommittingTool(name) }));
    const round = this.beginToolRound(sessionId, calls);
    for (const call of calls) if (call.committing) round.settle(true);
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

  /** True iff this signal belongs to the MOST RECENT acquirer of the
   *  session's turn slot. A wedged turn that was force-released and then
   *  outlived a replacement's acquire returns false — its persist must not
   *  full-rewrite history the newer turn already wrote ("agent forgot what
   *  I just said"). Signals the registry has never tagged (tests, paths
   *  that don't go through acquireTurn) pass: this guards lock-managed
   *  writers only, it is not a general write permission. */
  isCurrentTurnWriter(sessionId: string, signal: AbortSignal): boolean {
    const tag = this.writerTags.get(signal);
    if (!tag || tag.sessionId !== sessionId) return true;
    return tag.generation === this.generations.get(sessionId);
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

/** See TurnRegistry.hasActiveTurn. Stays true through a turn's salvage window
 *  (aborted / op already terminal, handler not yet through its finally). */
export function hasActiveTurn(sessionId: string): boolean {
  return registry.hasActiveTurn(sessionId);
}

export function markIteration(sessionId: string | undefined, toolNames: string[]): void {
  if (!sessionId) return;
  registry.markIteration(sessionId, toolNames);
}

/** See TurnRegistry.beginToolRound. Undefined session (a delegated/background
 *  op, or a caller outside the chat lane) returns the inert handle. */
export function beginToolRound(
  sessionId: string | undefined,
  calls: ToolRoundCall[],
): ToolRoundHandle {
  if (!sessionId) return INERT_ROUND;
  return registry.beginToolRound(sessionId, calls);
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

/** See TurnRegistry.isCurrentTurnWriter. Undefined session/signal → true
 *  (writer not lock-managed; only tagged stale writers are refused). */
export function isCurrentTurnWriter(sessionId: string | undefined, signal: AbortSignal | undefined): boolean {
  if (!sessionId || !signal) return true;
  return registry.isCurrentTurnWriter(sessionId, signal);
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
  // Snapshot `hasCommitted` covers both a settled commit and one in flight
  // (see ActiveTurnSnapshot). Both must survive a second user message. Every
  // other turn — including one whose committing call was DECLINED at the
  // approval gate, because dispatch settles that mark back down — falls through
  // to the replace path below and keeps its force-release safety net.
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
  // the slot can be acquired. This is a safety net for stuck handlers. The
  // acquire below bumps the session's write generation, so if the wedged
  // turn later un-wedges its persist is refused (isCurrentTurnWriter) instead
  // of full-rewriting the history the new turn wrote.
  if (registry.getActiveTurn(sessionId)) {
    registry.releaseTurn(sessionId);
  }
  registry.acquireTurn(sessionId, newAbortController, origin);
  return { allowed: true, reason: "aborted-non-committing", previous: existing };
}
