/**
 * Feature-flag reader for `lax.canonical_loop.{lane}` (PRD §17).
 *
 * Canonical-loop is the only execution path, so this returns `true`
 * unconditionally for every lane. The functions remain so existing call
 * sites (bootstrap, tests, soak scripts) keep compiling.
 */
import type { CanonicalLane } from "./types.js";

const LANE_ENV: Record<CanonicalLane, string> = {
  interactive: "LAX_CANONICAL_LOOP_INTERACTIVE",
  build: "LAX_CANONICAL_LOOP_BUILD",
  ide: "LAX_CANONICAL_LOOP_IDE",
  background: "LAX_CANONICAL_LOOP_BACKGROUND",
  agent: "LAX_CANONICAL_LOOP_AGENT",
};

export function isCanonicalLoopEnabled(_lane: CanonicalLane): boolean {
  return true;
}

export function envVarForLane(lane: CanonicalLane): string | undefined {
  return LANE_ENV[lane];
}
