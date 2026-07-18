import type { OpLane } from "../../ops/types.js";
import type { FiredMiddlewareResult } from "../middlewares/host.js";
import type { DriveTurnResult, MiddlewareDirective } from "./types.js";

export function middlewareSuspension(result: FiredMiddlewareResult): MiddlewareDirective | null {
  if (result.kind !== "suspend") return null;
  return {
    kind: "suspend",
    reason: result.reason,
    firedBy: result.firedBy ?? "unknown",
    message: result.message,
  };
}

export function suspendedTurn(result: FiredMiddlewareResult): DriveTurnResult | null {
  const directive = middlewareSuspension(result);
  if (!directive) return null;
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
