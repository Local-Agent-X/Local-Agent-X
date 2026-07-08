/**
 * Per-op token-usage aggregation — the shared seam read by both the soak
 * telemetry sink (soak-metrics.ts) and the live cost ledger writer
 * (cost-recording.ts).
 *
 * Sums `providerPayload.{usageInputTokens,usageOutputTokens,cacheReadTokens,
 * cacheCreateTokens}` across ALL op_turns (multi-round ops regularly hit 2-5
 * rounds, and reading only the latest turn loses earlier rounds' tokens), and
 * resolves the model from `op.contextPack.routing.preferredModel` ?? the last
 * turn's `providerPayload.model`.
 *
 * Pure: never writes, never throws. On any read failure it returns zeros with
 * `sawAnyUsage`/`sawAnyCache` false — matching soak's defensive posture, so a
 * corrupt op_turn can never break an op's terminal path.
 */
import { readOp } from "../ops/op-store.js";
import { readLatestOpTurn, readOpTurns } from "./store.js";
import { ANTHROPIC_ADAPTER_NAME } from "./adapters/anthropic/types.js";
import { lookupContextWindow } from "../context-manager/model-windows.js";

export interface OpUsageAggregate {
	usageInputTokens: number;
	usageOutputTokens: number;
	cacheReadTokens: number;
	cacheCreateTokens: number;
	model: string | null;
	sawAnyUsage: boolean;
	sawAnyCache: boolean;
}

export function aggregateOpUsage(opId: string): OpUsageAggregate {
	let usageInputTokens = 0;
	let usageOutputTokens = 0;
	let cacheReadTokens = 0;
	let cacheCreateTokens = 0;
	let sawAnyUsage = false;
	let sawAnyCache = false;
	let model: string | null = null;

	try {
		const turns = readOpTurns(opId);
		for (const t of turns) {
			const ps = t.providerState;
			const payload = ps?.providerPayload as Record<string, unknown> | undefined;
			if (payload) {
				const ui = payload.usageInputTokens;
				const uo = payload.usageOutputTokens;
				const cr = payload.cacheReadTokens;
				const cc = payload.cacheCreateTokens;
				if (typeof ui === "number") { usageInputTokens += ui; sawAnyUsage = true; }
				if (typeof uo === "number") { usageOutputTokens += uo; sawAnyUsage = true; }
				if (typeof cr === "number") { cacheReadTokens += cr; sawAnyCache = true; }
				if (typeof cc === "number") { cacheCreateTokens += cc; sawAnyCache = true; }
			}
		}

		// Model resolution: routing's preferredModel wins, else the last
		// turn's recorded providerPayload.model. Mirrors soak's resolution.
		const op = readOp(opId);
		model = (op?.contextPack?.routing as Record<string, unknown> | undefined)?.preferredModel as string | undefined
			?? (readLatestOpTurn(opId)?.providerState?.providerPayload as Record<string, unknown> | undefined)?.model as string | undefined
			?? null;
	} catch {
		// Defensive: a corrupt op_turn or missing op must not break the
		// caller's terminal path. Fall through with zeros / nulls.
		return {
			usageInputTokens: 0,
			usageOutputTokens: 0,
			cacheReadTokens: 0,
			cacheCreateTokens: 0,
			model: null,
			sawAnyUsage: false,
			sawAnyCache: false,
		};
	}

	return {
		usageInputTokens,
		usageOutputTokens,
		cacheReadTokens,
		cacheCreateTokens,
		model,
		sawAnyUsage,
		sawAnyCache,
	};
}

export interface LastTurnUsage {
	/** turn_idx of the most recent turn that recorded provider usage. */
	turnIdx: number;
	/**
	 * input + cache-read + cache-creation + output of that turn's response —
	 * the full context size AS OF that response (not cumulative billing;
	 * that's aggregateOpUsage's job).
	 */
	contextTokens: number;
}

/**
 * Real context size at the LAST turn that recorded usage, for the
 * anchor-plus-estimate context sizing in compact-history.ts. Pure and
 * non-throwing like aggregateOpUsage: any read failure → null (caller
 * falls back to the pure estimate).
 *
 * The formula input + cacheRead + cacheCreate + output equals the full
 * context ONLY under Anthropic usage semantics, where input_tokens EXCLUDES
 * the cached prefix. OpenAI-style prompt_tokens INCLUDES cached tokens, so
 * the same sum would double-count there. The anchor is therefore restricted
 * to turns the anthropic adapter recorded, and refused (null → pure-estimate
 * fallback) when any of these honesty conditions fail:
 *
 *  - adapterName !== "anthropic": semantics unknown or OpenAI-style.
 *  - viewCompacted is not an explicit boolean: the stamp (turn-loop commit)
 *    doubles as an era marker. Rows without it predate reliable recording —
 *    store audit found pre-marker tool-LESS rows carrying cumulative usage
 *    (op_memory_consolidation_4974b9544ccf4b56, claude-haiku-4-5: tool-less
 *    turns at 245k/286k/201k against a 200k window; worst case
 *    op_chat_turn_1e3cd8be27e949ed t0 = 3,032,073 with no observedTools),
 *    because observedTools recording only began 2026-06-26.
 *  - viewCompacted === true: the request behind this usage was the ephemeral
 *    COMPACTED view; anchoring it against the next turn's full replay
 *    under-sizes the context and freezes compaction one turn after it fired.
 *  - observedTools present: the CLI-proxy path ran tools in-stream, and its
 *    terminal result frame reports usage summed ACROSS those iterations, not
 *    the last request (op_chat_turn_544d968972fc456f t0, claude-opus-4-8,
 *    observedTools=2: 323k total for a plain chat turn). Post-marker
 *    tool-less turns satisfy the per-request identity — e.g.
 *    op_chat_turn_98d6d78d88a3465a total(t1)=141,877 ≈ cacheRead(t2)=141,728.
 *  - cache fields missing: "absent" is not "0". Old rows and the pre-cache-
 *    capture HTTP path omit them; treating that as zero would silently drop
 *    the cached prefix (the bulk of the context) from the anchor.
 *  - contextTokens above the model's context window (or model unresolvable):
 *    physically impossible for one request — some upstream call multiplied
 *    the count. Backstop for any future cumulative row that slips past the
 *    era marker (CLI-internal retries/auto-compaction making unnamed calls).
 *    Exactly-at-window is plausible and anchors.
 *
 * Residual (accepted): a post-marker tool-less turn whose transport made
 * hidden extra requests summing BELOW the window would still anchor and
 * overcount once — compaction then fires early, the compacted turn is
 * stamped, and the next turn falls back to the pure estimate. Bounded, and
 * strictly better than the always-pure-estimate status quo.
 */
export function lastTurnUsage(opId: string): LastTurnUsage | null {
	try {
		const turns = readOpTurns(opId);
		for (let i = turns.length - 1; i >= 0; i--) {
			const turn = turns[i];
			const ps = turn.providerState;
			const payload = ps?.providerPayload as Record<string, unknown> | undefined;
			if (!payload) continue;
			const input = payload.usageInputTokens;
			const output = payload.usageOutputTokens;
			// Not the anchoring turn unless it recorded usage at all (turns
			// that died before the provider responded record none — keep
			// scanning backward past those).
			if (typeof input !== "number" && typeof output !== "number") continue;
			// This IS the last usage-bearing turn. Refusals below return null
			// outright — an earlier turn's usage predates even more history and
			// the honest fallback is the whole-view estimate.
			if (ps.adapterName !== ANTHROPIC_ADAPTER_NAME) return null;
			if (typeof ps.viewCompacted !== "boolean") return null; // pre-marker era
			if (ps.viewCompacted) return null;
			if ((turn.observedTools?.length ?? 0) > 0) return null;
			const cacheRead = payload.cacheReadTokens;
			const cacheCreate = payload.cacheCreateTokens;
			if (
				typeof input !== "number" || typeof output !== "number" ||
				typeof cacheRead !== "number" || typeof cacheCreate !== "number"
			) return null;
			const contextTokens = input + cacheRead + cacheCreate + output;
			// Plausibility clamp: the turn's own recorded model, no defaulting.
			const model = payload.model;
			if (typeof model !== "string" || model.length === 0) return null;
			if (contextTokens > lookupContextWindow(model)) return null;
			return { turnIdx: turn.turnIdx, contextTokens };
		}
		return null;
	} catch {
		return null;
	}
}
