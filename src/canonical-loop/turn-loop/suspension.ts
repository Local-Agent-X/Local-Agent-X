import type { OpLane } from "../../ops/types.js";
import type { FiredMiddlewareResult } from "../middlewares/host.js";
import type { DriveTurnResult, MiddlewareDirective } from "./types.js";
import { directiveFire, recordGuardFire } from "./guard-fire.js";

export function middlewareSuspension(result: FiredMiddlewareResult): MiddlewareDirective | null {
  if (result.kind !== "suspend") return null;
  return {
    kind: "suspend",
    reason: result.reason,
    firedBy: result.firedBy ?? "unknown",
    message: result.message,
  };
}

/** The beforeTurn suspend — repeat-failure / thrash-guard pausing a worker lane
 *  before the model is ever called. It returns the turn on the spot, so it never
 *  reaches the post-commit directive path (apply-directive.ts) that counts every
 *  other suspend: this is the only place it can be recorded. */
export function suspendedTurn(
  opId: string,
  turnIdx: number,
  result: FiredMiddlewareResult,
): DriveTurnResult | null {
  const directive = middlewareSuspension(result);
  if (!directive) return null;
  recordGuardFire(opId, turnIdx, directiveFire(directive));
  return {
    terminalReason: null,
    toolCount: 0,
    messageCount: 0,
    cancelled: false,
    middlewareDirective: directive,
  };
}

export function idleSuspension(
  lane: OpLane,
  error: { code: string; message: string } | null,
): MiddlewareDirective | null {
  if (lane === "interactive" || error?.code !== "stalled") return null;
  return {
    kind: "suspend",
    reason: "idle-stalled",
    firedBy: "idle-watchdog",
    message: error.message,
  };
}
