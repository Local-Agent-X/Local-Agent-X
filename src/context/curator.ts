/**
 * Context curator — decides what to include in the per-turn context.
 *
 * Scoring/ranking which memory hits, which past messages, which references
 * make the cut for this turn's context window budget.
 *
 * Today LAX's curation logic is split between:
 *   - memoryManager.buildTurnContext (memory hit selection)
 *   - prepare-request.ts (Codex-vs-Anthropic context truncation)
 *   - tool-filter.ts (which tools to expose)
 *   - context-manager.ts checkAndCompact (history pruning)
 *
 * Migration target: surface a single curate() function callers use to
 * decide what goes in. For now, this file is the named boundary; actual
 * curation logic stays where it is until each caller is touched.
 */

import { isContextOverflowError } from "../errors/index.js";

/**
 * Re-export from errors module so context-related code can import from
 * one place. Same function, different conceptual home (errors classifier
 * owns the regex; context curator decides "if overflow, compress").
 */
export { isContextOverflowError };
