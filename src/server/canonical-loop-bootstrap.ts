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

  // Stale-op recovery sweep is a fire-and-forget — no caller waits for the
  // result. Used to run synchronously inside this function and added 9-18s
  // to boot (it scans every op directory on disk and re-reads JSON). Now
  // backgrounded so server.listen() isn't gated by recovery work. New ops
  // submitted during the sweep window are unaffected — they go through
  // submitCanonicalOp which doesn't touch lease-expired rows.
  setImmediate(() => {
    const t = Date.now();
    try {
      const recovered = sweepStaleCanonicalOps();
      const dt = Date.now() - t;
      if (recovered.length > 0) {
        const summary = recovered
          .map(r => `${r.opId}=${r.outcome.kind}`)
          .join(", ");
        logger.info(`[canonical-loop] background sweep recovered ${recovered.length} stale op(s) in ${dt}ms: ${summary}`);
      } else {
        logger.info(`[canonical-loop] background sweep completed in ${dt}ms (no stale ops)`);
      }
    } catch (e) {
      logger.warn(`[canonical-loop] background sweep failed: ${(e as Error).message}`);
    }
  });
}
