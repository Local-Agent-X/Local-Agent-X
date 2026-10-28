// Compaction & truncation POLICY — the single authority for "when do we
// compact and how much survives". Every budget, threshold, and keep count that
// decides those questions lives in context-manager:
//
//   token-estimation.ts  chars→tokens ratio + message/anchored counting
//   model-windows.ts     nominal window table + provider fallbacks
//   effective-window.ts  transport-aware window clamp (CLI/OAuth ≈ 200k)
//   status.ts            fullness → warn/compact/critical verdict
//   compaction.ts        the one LLM summarizer (prompt + call)
//   THIS FILE            the per-lane trigger bands, keep counts, and digest
//                        budgets those verdicts and the lanes act on
//
// POLICY vs LANE MECHANICS — what deliberately stays at the call sites:
//   canonical-loop/turn-loop/compact-history.ts  CanonicalMessage→chat
//     projection, tool-pairing-safe split, usage-anchor mapping, the
//     summarize circuit breaker, and how the summary row is folded in.
//   providers/sanitize.ts  provider-shape sanitizing, the user-boundary cut
//     walk, digest line rendering, and the background summary cache.
// Those decide HOW a lane reshapes its view, never WHEN or HOW MUCH — if a
// number here changes, both lanes move together.
//
// WHEN to compact is one user setting, "Compact at" (compactAtPercent, default
// 90), and every lane reads it: providers serve the whole measured window, and
// quality held at every size tested. Measured 2026-10-26 on the owner's two
// day-to-day models (a long coding transcript with an early constraint, a
// buried fact, a revised decision; scored by regex, two runs per size):
// gpt-6-sol and claude-opus-5-5 answered correctly at ~145K, 290K, 435K,
// 578K, 720K and 860K input tokens. The old Codex lane compacted at 35% on
// the strength of one 334K run in April that lost its task, on an older model
// in a harness with many since-fixed bugs; it did not reproduce.
//
// The keep units still differ by lane on purpose:
//   - the turn loop keeps a token-pressure-tiered COUNT of rows (6/4/2),
//     widened in the default band to a token budget (TURN_TAIL_WINDOW_SHARE),
//     because it resizes per turn against the model window; before any of
//     that it stubs older rounds' tool output (PRUNE_KEEP_TOOL_ROUNDS);
//   - the chat lane keeps a flat per-channel row count (40 web / 30
//     otherwise) because it truncates before token sizing ever runs.

import { getSetting } from "../settings.js";
import { COMPACT_AT_RANGE, DEFAULT_COMPACT_AT } from "./compact-at-range.js";

// ─── Trigger bands (consumed by status.ts) ──────────────────────────────────

export interface CompactionTriggers {
	/** UI warning — nothing fires yet. */
	warningAt: number;
	/** shouldCompact: summarize at the next opportunity. */
	compactAt: number;
	/** forceCompact: critical, compact now. */
	criticalAt: number;
}

export { DEFAULT_COMPACT_AT, COMPACT_AT_RANGE };

/** The user's "Compact at", in percent of the model's measured window. */
export function compactAtPercent(): number {
	const v = getSetting<number>("compactAtPercent");
	return typeof v === "number" && Number.isFinite(v) && v >= COMPACT_AT_RANGE.min && v <= COMPACT_AT_RANGE.max
		? Math.round(v)
		: DEFAULT_COMPACT_AT;
}

/** The bands, all derived from "Compact at": the UI warns 15 points before,
 *  and compaction is forced 5 points after (never past 97). */
export function compactionTriggers(compactAt: number = compactAtPercent()): CompactionTriggers {
	return { warningAt: compactAt - 15, compactAt, criticalAt: Math.min(97, compactAt + 5) };
}

// ─── Turn-loop keep tiers (consumed by turn-loop/compact-history.ts) ────────

/**
 * How many trailing rows the turn loop keeps verbatim when it compacts,
 * tightening as fullness climbs. `forced` = the provider already rejected the
 * call as over-window, so the estimate is proven low — keep the aggressive
 * minimum instead of trusting it.
 */
export const TURN_KEEP_TIERS = {
	default: 6,
	tight: 4, // at ≥ tightAtPct
	aggressive: 2, // when forced, or at ≥ aggressiveAtPct
	tightAtPct: 95,
	aggressiveAtPct: 99,
} as const;

/**
 * How many rows the summarized HEAD may grow before the turn loop re-runs the
 * summarizer (consumed by turn-loop/compact-summary-cache.ts). Same number and
 * reason as any summary cache: don't re-summarize on every turn. It is load-bearing here for a second
 * reason — the turn loop rebuilds its view from op_messages every turn, so a
 * per-turn re-summarize also rewrites message index 0 every turn and destroys
 * the Anthropic message-tier cache prefix.
 */
export const TURN_SUMMARY_REFRESH_MIN_GROWTH = 10;

/**
 * In the default band the turn loop keeps, after a summary, as many recent rows
 * verbatim as fit in this share of the window — never fewer than the keep
 * tier's count, and never more than half the conversation's own tokens, so a
 * summary always frees at least half of it even when the system prompt is the
 * bulk of the window. Six rows is three tool calls of working memory; a fifth
 * of a measured window is the recent stretch a coding agent keeps referring
 * back to. The tight and aggressive tiers, and a forced pass, keep their counts:
 * there the estimate may already be low.
 */
export const TURN_TAIL_WINDOW_SHARE = 0.2;

export function turnTailBudgetTokens(percentage: number, forced: boolean, windowTokens: number, conversationTokens: number): number {
	if (forced || percentage >= TURN_KEEP_TIERS.tightAtPct) return 0;
	return Math.floor(Math.min(windowTokens * TURN_TAIL_WINDOW_SHARE, conversationTokens / 2));
}

export function turnCompactionKeepLast(percentage: number, forced: boolean): number {
	let keepLast: number = TURN_KEEP_TIERS.default;
	if (percentage >= TURN_KEEP_TIERS.tightAtPct) keepLast = TURN_KEEP_TIERS.tight;
	if (forced || percentage >= TURN_KEEP_TIERS.aggressiveAtPct) keepLast = TURN_KEEP_TIERS.aggressive;
	return keepLast;
}

// ─── Chat-lane keep counts (consumed by providers/sanitize.ts) ──────────────

// ─── Between-messages checkpoint (context-manager/checkpoint-history.ts) ────
//
// The successor to chatHistoryWindow above. That window bounds history by ROW
// COUNT and re-cuts on a schedule; these bound it by TOKENS and cut once,
// persisting the result, so the old part of a conversation is byte-identical
// from one message to the next.

/** Share of the model's window the CONVERSATION may occupy before the old part
 *  is checkpointed: the warning line, 15 points under "Compact at". This runs
 *  BETWEEN messages, so a turn that starts here has a full band of room to
 *  work before the in-turn compaction at "Compact at" fires. */
export function conversationBudgetShare(compactAt: number = compactAtPercent()): number {
	return compactionTriggers(compactAt).warningAt / 100;
}

/** Messages always kept verbatim after a checkpoint, so the model still sees
 *  the immediate exchange rather than a summary of it. */
export const CHECKPOINT_KEEP_RECENT = 8;

/** Re-cut only once the verbatim tail has grown this much past the last
 *  checkpoint. Sibling of TURN_SUMMARY_REFRESH_MIN_GROWTH: without it the
 *  boundary advances every message and the prefix churns again. */
export const CHECKPOINT_REFRESH_MIN_GROWTH = 12;

// ─── Finished-turn tool results (context-manager/prune-tool-results.ts) ─────

/** A tool result from a turn before the last one is stubbed in the model's
 *  view unless it is this short: an error line or a one-word answer carries
 *  more than its stub would, and costs nothing to keep. */
export const PRUNED_RESULT_KEEP_CHARS = 200;

// ─── Tool rounds inside one op (canonical-loop/turn-loop/prune-tool-rounds.ts) ─

/**
 * Inside one long op — a code task, an agent job — every tool call answers the
 * same user message, so the finished-turn prune above never fires and the raw
 * output of dozens of rounds stays in view until the summary at "Compact at".
 * Output older than the newest PRUNE_KEEP_TOOL_ROUNDS rounds is stubbed instead,
 * in batches: the boundary moves only when moving it takes out at least
 * PRUNE_BATCH_MIN_RECLAIM_TOKENS, so the view before the old boundary stays
 * byte-identical and a local runtime re-reads only the stretch after it. A result
 * no longer than PRUNE_MIN_RESULT_CHARS is kept; it costs less than it says.
 */
export const PRUNE_KEEP_TOOL_ROUNDS = 6;
export const PRUNE_BATCH_MIN_RECLAIM_TOKENS = 16_384;
export const PRUNE_MIN_RESULT_CHARS = 1_500;

// ─── Manual compaction keep count (consumed by routes/chat/compact-route.ts) ─

/**
 * Rows the manual "Compact" button (POST /api/compact) keeps verbatim. Unlike
 * the turn loop (token-pressure-tiered) and the chat lane (per-channel), the
 * button runs on explicit user demand, not at a fullness threshold, so it keeps
 * a single flat count — smaller than the auto-truncate counts because the user
 * is deliberately reclaiming context right now. The caller still snaps the cut
 * forward to the next user-message boundary, so this is a lower bound on kept
 * rows, and clamps it against the session length.
 */
export const MANUAL_COMPACT_KEEP_RECENT = 20;

