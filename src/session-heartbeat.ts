// Per-turn heartbeat emitter.
//
// While a long-running turn is in flight, the frontend used to show "Still
// waiting..." with no detail — the user had no signal that the agent was
// alive, stuck, or making progress. This module exposes a ticker that the
// agent loops start at turn-begin and stop at turn-end; every tick emits an
// onEvent({type: "heartbeat", ...}) that the UI can render as "iteration 5,
// last tool bash, 42s elapsed."
//
// Cheap: an unref'd interval so it never blocks process exit.

import type { ServerEvent } from "./types.js";
import { getActiveTurn } from "./session-turn-lock.js";

export interface HeartbeatHandle {
  stop: () => void;
}

interface HeartbeatOpts {
  sessionId?: string;
  intervalMs?: number;
  onEvent?: (event: ServerEvent) => void;
  turnStartMs: number;
}

/**
 * Start emitting heartbeat events. Returns a handle; call stop() in the
 * turn's finally block. If onEvent is undefined (cron/background flows)
 * the heartbeat is a no-op.
 */
export function startHeartbeat(opts: HeartbeatOpts): HeartbeatHandle {
  const { sessionId, onEvent, turnStartMs } = opts;
  const intervalMs = opts.intervalMs ?? 5000;
  if (!onEvent || !sessionId) {
    return { stop: () => {} };
  }
  const timer = setInterval(() => {
    const turn = getActiveTurn(sessionId);
    if (!turn) return; // lock released — turn probably ended already
    try {
      // We emit a custom "heartbeat" event. The UI treats it as a progress
      // tick; stores that don't handle it ignore the unknown type. Cast
      // through unknown because the ServerEvent union doesn't list heartbeat
      // yet — intentional escape hatch for progressively-enhanced telemetry.
      const evt = {
        type: "heartbeat",
        sessionId,
        iteration: turn.iteration,
        lastToolName: turn.lastToolName,
        elapsedMs: Date.now() - turnStartMs,
        toolsCalled: turn.toolsCalled,
      };
      (onEvent as unknown as (e: typeof evt) => void)(evt);
    } catch { /* never let a heartbeat break the turn */ }
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return {
    stop: () => { try { clearInterval(timer); } catch {} },
  };
}
