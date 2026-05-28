/**
 * Context compressor — token tracking + auto-compaction.
 *
 * Wraps the existing src/context-manager.ts implementation. The wrapping
 * is intentional: the canonical implementation stays in context-manager.ts
 * for now (broad import surface across the codebase, won't be moved in this
 * refactor pass), but src/context/ owns the named module surface so future
 * code imports from src/context/ instead of the top-level path.
 *
 * Subsequent passes will move actual logic into this file and shrink
 * context-manager.ts to a re-exporter — but moving 200+ import sites at
 * once is risky. The named-module facade lets the migration happen file
 * by file as each caller is touched for other reasons.
 */

export {
  estimateTokens,
  messageTokens,
  totalTokens,
  type ContextStatus,
} from "../context-manager/index.js";
