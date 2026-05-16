/**
 * Submit-time routing decision (PRD §17).
 *
 * Phase 2 of the worker-pool retirement collapsed this to a stub: canonical
 * is the only execution path, so every call returns canonical. The signature
 * is preserved for callers that still capture the routing decision (the
 * per-op `flagValue` is still stamped onto the canonical op fields).
 *
 * See docs/migration/worker-pool-retirement.md.
 */
import type { Op } from "../ops/types.js";
import type { CanonicalLane } from "./types.js";

export interface SubmitRouting {
  route: "canonical";
  flagValue: true;
  lane: CanonicalLane;
}

export function decideSubmitRouting(op: Pick<Op, "lane">): SubmitRouting {
  return {
    route: "canonical",
    flagValue: true,
    lane: op.lane as CanonicalLane,
  };
}
