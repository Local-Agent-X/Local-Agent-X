/**
 * Heartbeat ticker — fires periodic "still working" events to the UI
 * so the user doesn't see "Still waiting..." with no other signal
 * during a long tool call. Auto-stops when the session turn-lock
 * releases.
 *
 * Only fires once per turn (on iteration 0). Subsequent iterations
 * are no-ops because the heartbeat is already running.
 */

import type { LoopMiddleware } from "../types.js";

export const heartbeatMiddleware: LoopMiddleware = {
  name: "heartbeat",

  async beforeIteration(ctx) {
    if (ctx.iteration > 0) return { kind: "continue" };
    try {
      const { startHeartbeat } = await import("../../session-heartbeat.js");
      const heartbeat = startHeartbeat({
        sessionId: ctx.req.sessionId,
        onEvent: ctx.req.onEvent,
        turnStartMs: ctx.turnStartMs,
      });
      const { onTurnRelease } = await import("../../session-turn-lock.js");
      onTurnRelease(ctx.req.sessionId, () => heartbeat.stop());
    } catch {
      // Heartbeat is cosmetic; don't fail the turn if it can't start.
    }
    return { kind: "continue" };
  },
};
