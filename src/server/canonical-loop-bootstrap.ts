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
} from "../canonical-loop/index.js";
import { createLogger } from "../logger.js";

const logger = createLogger("server.canonical-loop-bootstrap");

/**
 * When the canonical-loop flag is on for the interactive lane, register
 * the default Anthropic adapter so submitted ops have a factory to drive
 * the turn loop. Without this the canonical route persists the op as
 * queued and then fails on the next microtask with adapter_not_configured.
 * Legacy behavior is unchanged when the flag is off.
 */
export function bootstrapCanonicalLoop(): void {
  if (!isCanonicalLoopEnabled("interactive")) return;
  setDefaultAdapterForLane("interactive", () => createAnthropicAdapter());
  logger.info("[canonical-loop] interactive lane → AnthropicAdapter registered");
}
