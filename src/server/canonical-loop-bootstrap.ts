/**
 * Production canary bootstrap for the canonical-loop.
 *
 * Lives in its own module (rather than inline in lifecycle.ts) so the test
 * suite can import it without dragging the full server transitive graph
 * (ari-kernel and friends) through the vitest resolver.
 */
import {
  isCanonicalLoopEnabled,
  setDefaultAdapterForLane,
  createAnthropicAdapter,
  sweepStaleCanonicalOps,
} from "../canonical-loop/index.js";
import type { CanonicalLane } from "../canonical-loop/types.js";
import { createLogger } from "../logger.js";

const logger = createLogger("server.canonical-loop-bootstrap");

const ALL_LANES: CanonicalLane[] = ["interactive", "build", "ide", "background"];

/**
 * For every lane whose canonical-loop flag is on, register the default
 * Anthropic adapter so submitted ops have a factory to drive the turn
 * loop. Without this the canonical route persists the op as queued and
 * then fails on the next microtask with adapter_not_configured. Legacy
 * behavior is unchanged when a lane's flag is off.
 *
 * Also runs a one-shot sweep of stale canonical ops on disk: any op
 * left in `running` / `cancelling` with an expired lease (typically
 * because the prior server got SIGTERM mid-op) is routed through the
 * canonical-loop's `recoverStaleOp` primitive so it transitions to
 * a clean terminal/queued state instead of sitting orphaned forever.
 */
export function bootstrapCanonicalLoop(): void {
  const enabled = ALL_LANES.filter(isCanonicalLoopEnabled);
  if (enabled.length === 0) return;

  for (const lane of enabled) {
    setDefaultAdapterForLane(lane, () => createAnthropicAdapter());
  }
  logger.info(`[canonical-loop] AnthropicAdapter registered for lanes: ${enabled.join(", ")}`);

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
