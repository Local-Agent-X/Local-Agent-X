/**
 * Context module — owner of context engineering: turn-context assembly,
 * compression, reference resolution, curation.
 *
 * 4 named files for 4 distinct responsibilities.
 * Today most of these are facades over existing code (context-manager.ts,
 * memory-manager.ts) — the named surface establishes the boundary. As
 * call sites are touched for other reasons, they should be migrated to
 * import from src/context/ directly so the underlying files can shrink
 * over time.
 */

export {
  estimateTokens,
  messageTokens,
  totalTokens,
  type ContextStatus,
} from "./compressor.js";

export type { TurnContextOptions } from "./engine.js";

export { isContextOverflowError } from "./curator.js";
