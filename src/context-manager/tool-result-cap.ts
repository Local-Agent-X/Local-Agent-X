/**
 * Per-tool-result size cap as a FUNCTION OF THE TARGET WINDOW.
 *
 * Why: the audit phase (tool-execution/audit-tool-call.ts) used to budget
 * every tool result at a flat 50,000 chars (~14k tokens) regardless of the
 * model. On a 65,536-token local model the fixed overhead (system prompt at
 * PROMPT_WINDOW_SHARE + the tool manifest + the response reserve) already
 * takes ~58% of the window, so TWO flat-capped results overflow it inside a
 * single step — where compaction cannot help (it only runs between steps).
 * Live 2026-09-08 02:46Z: 15 actions -> messages 29,725 tokens ->
 * context_window_exceeded.
 *
 * Pure sizing math only. The caller resolves the window (model-windows.ts
 * resolveContextWindow) and decides whether the number is trustworthy — a
 * "floor" placeholder for an unloaded local model must NOT be sized against
 * (same rule as the openai-compat preflight and build-input's baseline).
 *
 * Arithmetic for the 65,536 window that exposed the bug, with the
 * documented manifest allowance:
 *   prompt share      = floor(65,536 * 0.35)                 = 22,937
 *   tool manifest     = DEFAULT_TOOL_MANIFEST_TOKENS          = 14,000
 *   response reserve  = OUTPUT_RESERVE_TOKENS                 =  1,024
 *   left for messages = 65,536 - 22,937 - 14,000 - 1,024      = 27,575
 *   one result        = floor(27,575 / 4)                     =  6,893 tokens
 *   in chars          = floor(6,893 * 3.5)                    = 24,125 chars
 * versus the flat 50,000. Four max-size results (one parallel batch) now fit
 * in the message budget exactly, instead of two blowing the whole window.
 * At 131,072 the same math gives ~61k chars, so it clamps to the 50k default:
 * every window >= ~118k (every cloud model) is byte-for-byte unchanged.
 */
import { OUTPUT_RESERVE_TOKENS, PROMPT_WINDOW_SHARE } from "./request-fit.js";

/** The flat cap every model used before the window-aware cap; still the
 *  ceiling, so large windows keep the historical behavior. Mirrored (not
 *  imported) by the audit phase's DEFAULT_MAX_RESULT_SIZE — one number. */
export const DEFAULT_MAX_RESULT_CHARS = 50_000;

/** Never squeeze a single result below this — a cap smaller than a screen of
 *  text makes every read/grep/shell result useless and the model just re-calls
 *  the tool. At this size the spill-to-disk preview still tells the model where
 *  the rest lives. */
export const MIN_RESULT_CAP_CHARS = 4_000;

/** Fallback tool-manifest allowance when the caller cannot measure the tools
 *  it actually sent. Sized on the medium-tier manifest measured 2026-09-08
 *  (23 tools, ~13,617 tokens) rounded up; the same figure PROMPT_WINDOW_SHARE
 *  was derived against. */
export const DEFAULT_TOOL_MANIFEST_TOKENS = 14_000;

/** A single result may take at most this share of the message budget, so one
 *  parallel batch of that many max-size results fits in a step. */
const RESULT_SHARE_OF_MESSAGES = 1 / 4;

/** Inverse of token-estimation.ts estimateTokens (chars / 3.5). Kept as the
 *  same literal so the cap and the estimate agree on what a token is. */
const CHARS_PER_TOKEN = 3.5;

/**
 * Chars one tool result may occupy in a model whose window is `windowTokens`.
 * `toolTokens` is the measured manifest (request-fit.ts toolManifestTokens)
 * when the caller has the tools it sent; otherwise the documented allowance.
 * Monotonic in the window, clamped to [MIN_RESULT_CAP_CHARS,
 * DEFAULT_MAX_RESULT_CHARS].
 */
export function toolResultCapChars(
  windowTokens: number,
  toolTokens: number = DEFAULT_TOOL_MANIFEST_TOKENS,
): number {
  if (!Number.isFinite(windowTokens) || windowTokens <= 0) return DEFAULT_MAX_RESULT_CHARS;
  const promptTokens = Math.floor(windowTokens * PROMPT_WINDOW_SHARE);
  const messageTokens = windowTokens - promptTokens - toolTokens - OUTPUT_RESERVE_TOKENS;
  const resultTokens = Math.floor(messageTokens * RESULT_SHARE_OF_MESSAGES);
  const chars = Math.floor(resultTokens * CHARS_PER_TOKEN);
  return Math.min(DEFAULT_MAX_RESULT_CHARS, Math.max(MIN_RESULT_CAP_CHARS, chars));
}
