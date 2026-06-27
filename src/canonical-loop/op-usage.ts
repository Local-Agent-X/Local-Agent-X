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
