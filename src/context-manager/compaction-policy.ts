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
// The lanes' values genuinely DIFFER on purpose — do not unify them:
//   - Trigger bands: Codex compacts far earlier (25/35/55) than the default
//     lane (60/75/90) because its long-context agentic focus degrades well
//     before the nominal window (see isCodexModel).
//   - Keep units: the turn loop keeps a token-pressure-tiered COUNT of rows
//     (6/4/2) because it resizes per turn against the model window; the chat
//     lane keeps a flat per-channel row count (40 web / 30 otherwise) because
//     it truncates before token sizing ever runs.

import { isCodexModel } from "./model-windows.js";

// ─── Trigger bands (consumed by status.ts) ──────────────────────────────────

export interface CompactionTriggers {
	/** UI warning — nothing fires yet. */
	warningAt: number;
	/** shouldCompact: summarize at the next opportunity. */
	compactAt: number;
	/** forceCompact: critical, compact now. */
	criticalAt: number;
}

/** Default lane (Anthropic + everything that is not Codex). */
export const DEFAULT_TRIGGERS: CompactionTriggers = { warningAt: 60, compactAt: 75, criticalAt: 90 };

/**
 * Codex compacts much earlier: its long-context agentic reasoning falls apart
 * well before the nominal limit (a 334k-token turn ended with "I'm missing the
 * actual task context"). Anthropic holds focus and keeps the looser bands.
 */
export const CODEX_TRIGGERS: CompactionTriggers = { warningAt: 25, compactAt: 35, criticalAt: 55 };

export function compactionTriggersFor(model: string): CompactionTriggers {
	return isCodexModel(model) ? CODEX_TRIGGERS : DEFAULT_TRIGGERS;
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

export function turnCompactionKeepLast(percentage: number, forced: boolean): number {
	let keepLast: number = TURN_KEEP_TIERS.default;
	if (percentage >= TURN_KEEP_TIERS.tightAtPct) keepLast = TURN_KEEP_TIERS.tight;
	if (forced || percentage >= TURN_KEEP_TIERS.aggressiveAtPct) keepLast = TURN_KEEP_TIERS.aggressive;
	return keepLast;
}

// ─── Chat-lane keep counts (consumed by providers/sanitize.ts) ──────────────

/** Rows kept verbatim per channel when the chat lane truncates a session. */
export const CHAT_KEEP = { web: 40, default: 30 } as const;

export function chatHistoryMaxKeep(channel: string): number {
	return channel === "web" ? CHAT_KEEP.web : CHAT_KEEP.default;
}

// ─── Chat-lane digest budgets (consumed by providers/sanitize.ts) ───────────

/**
 * Char budgets for the deterministic digest that stands in for truncated chat
 * history (whatever the background LLM summary does not yet cover). User turns
 * are the constraint carriers, so they keep by far the largest slice — head
 * AND tail, because constraints cluster at the start and END of long specs.
 */
export const CHAT_DIGEST_BUDGETS = {
	/** Leading chars of an old user message kept verbatim. */
	userKeepHead: 2000,
	/** Trailing chars of an old user message kept verbatim. */
	userKeepTail: 1000,
	/** Max chars of an old assistant message. */
	assistantMax: 300,
	/** Max chars of an old tool result. */
	toolMax: 200,
	/**
	 * Total digest budget, spent newest-first (older turns are likelier
	 * superseded AND likelier already covered by the LLM summary) — a
	 * mega-session can never re-bloat the window truncation just reclaimed.
	 */
	totalChars: 24_000,
	/**
	 * Don't re-summarize on every turn — refresh the background LLM summary
	 * once the uncovered gap has grown past this many messages.
	 */
	summaryRefreshMinGrowth: 10,
} as const;
