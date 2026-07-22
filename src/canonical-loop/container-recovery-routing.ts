import type { Op } from "../ops/types.js";
import { readProcessExecutionClaim } from "./process-execution-claim.js";
import { enqueueOp, pumpScheduler } from "./scheduler.js";
import type { CanonicalLane } from "./types.js";

export function routeContainerRecovery(op: Op): "not-container" | "changed" | "routed" {
  const claim = readProcessExecutionClaim(op.id);
  if (claim?.ownerKind !== "container") return "not-container";
  const placement = op.canonical?.executionPlacement;
  if (!placement || placement.backendId !== claim.backendId || placement.targetId !== claim.targetId
    || placement.revision !== claim.placementRevision) return "changed";
  enqueueOp(op.id, op.lane as CanonicalLane);
  pumpScheduler();
  return "routed";
}
