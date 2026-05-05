/**
 * Submit-time routing decision (PRD §17).
 *
 * Pure function — no side effects, no DB writes, no env caching. The flag
 * value at the moment of submission becomes immutable for the op's lifetime
 * (captured on `op.canonical.flagValue` by the caller).
 */
import type { Op } from "../workers/types.js";
import type { CanonicalLane } from "./types.js";
import { isCanonicalLoopEnabled } from "./feature-flag.js";

export interface SubmitRouting {
  route: "legacy" | "canonical";
  flagValue: boolean;
  lane: CanonicalLane;
}

export function decideSubmitRouting(op: Pick<Op, "lane">): SubmitRouting {
  const lane = op.lane as CanonicalLane;
  const flagValue = isCanonicalLoopEnabled(lane);
  return {
    route: flagValue ? "canonical" : "legacy",
    flagValue,
    lane,
  };
}
