/**
 * Production canary bootstrap for the canonical-loop.
 *
 * Lives in its own module (rather than inline in lifecycle.ts) so the test
 * suite can import it without dragging the full server transitive graph
 * (ari-kernel and friends) through the vitest resolver.
 */
import {
  setDefaultAdapterForLane,
  createAnthropicAdapter,
  sweepStaleCanonicalOps,
} from "../canonical-loop/index.js";
import type { CanonicalLane } from "../canonical-loop/types.js";
import { createLogger } from "../logger.js";

const logger = createLogger("server.canonical-loop-bootstrap");

const ALL_LANES: CanonicalLane[] = ["interactive", "build", "ide", "background"];

/**
 * Register the default Anthropic adapter for every lane so submitted ops
 * have a factory to drive the turn loop. Without this the canonical route
 * persists the op as queued and then fails on the next microtask with
 * adapter_not_configured.
 *
 * Also runs a one-shot sweep of stale canonical ops on disk: any op left
 * in `running` / `cancelling` with an expired lease (typically because
 * the prior server got SIGTERM mid-op) is routed through the
 * canonical-loop's `recoverStaleOp` primitive so it transitions to a
 * clean terminal/queued state instead of sitting orphaned forever.
 */
export function bootstrapCanonicalLoop(): void {
  for (const lane of ALL_LANES) {
    setDefaultAdapterForLane(lane, () => createAnthropicAdapter());
  }
  logger.info(`[canonical-loop] AnthropicAdapter registered for lanes: ${ALL_LANES.join(", ")}`);

  try {
    const recovered = sweepStaleCanonicalOps();
    if (recovered.length > 0) {
      const summary = recovered
        .map(r => `${r.opId}=${r.outcome.kind}`)
        .join(", ");
      logger.info(`[canonical-loop] boot-sweep recovered ${recovered.length} stale op(s): ${summary}`);
    }
  } catch (e) {
    logger.warn(`[canonical-loop] boot-sweep failed: ${(e as Error).message}`);
  }
}
