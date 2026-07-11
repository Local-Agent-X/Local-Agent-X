import type { AuditEvent, RunContext } from "@arikernel/core";
import { genesisHash, verifyChain } from "./hash-chain.js";
import type { AuditStore } from "./store.js";

export interface ReplayResult {
	runContext: RunContext;
	events: AuditEvent[];
	integrity: ReplayIntegrity;
}

export interface ReplayIntegrity {
	valid: boolean;
	brokenAt?: number;
	anchorValid?: boolean;
	sequenceValid?: boolean;
	sequenceError?: string;
}

function verifyGlobalEvents(store: AuditStore): {
	events: AuditEvent[];
	valid: boolean;
	brokenAt?: number;
	anchorValid: boolean;
} {
	const events = store.queryAllEvents();
	const chain = verifyChain(
		events.map((e) => ({
			hash: e.hash,
			previousHash: e.previousHash,
			data: JSON.stringify({ toolCall: e.toolCall, decision: e.decision, result: e.result }),
		})),
		store.getHmacKey(),
	);
	// The chain anchors at genesis — or, after a retention purge, at the
	// recorded anchor (hash of the newest purged event; see purgeEventsBefore).
	const retentionAnchor = store.getChainAnchor();
	let anchorValid =
		events.length === 0 ||
		events[0].previousHash === genesisHash() ||
		(retentionAnchor !== null && events[0].previousHash === retentionAnchor);
	for (let i = 1; i < events.length; i++) {
		if (!events[i].previousHash || events[i].previousHash === genesisHash()) {
			anchorValid = false;
			break;
		}
	}
	return {
		events,
		valid: chain.valid && anchorValid,
		brokenAt: chain.brokenAt,
		anchorValid,
	};
}

function runAnchorIsAncestor(
	allEvents: AuditEvent[],
	run: RunContext,
	runEvents: AuditEvent[],
	retentionAnchor: string | null,
): boolean {
	if (runEvents.length === 0 || run.startPreviousHash == null) return true;
	const firstGlobalIndex = allEvents.findIndex((event) => event.id === runEvents[0].id);
	// A run may start-anchor on genesis, on a retained event, or — after a
	// retention purge — on the recorded retention anchor (its ancestor event
	// was purged; the anchor proves it preceded everything retained).
	const anchoredAtBoundary =
		run.startPreviousHash === genesisHash() ||
		(retentionAnchor !== null && run.startPreviousHash === retentionAnchor);
	const anchorIndex = anchoredAtBoundary
		? -1
		: allEvents.findIndex((event) => event.hash === run.startPreviousHash);
	const anchorKnown = anchoredAtBoundary || anchorIndex >= 0;
	return anchorKnown && anchorIndex < firstGlobalIndex;
}

export function replayRun(store: AuditStore, runId: string): ReplayResult | null {
	const runContext = store.getRunContext(runId);
	if (!runContext) return null;

	const events = store.queryRun(runId);
	const global = verifyGlobalEvents(store);
	const integrity: ReplayIntegrity = {
		valid: global.valid,
		brokenAt: global.brokenAt,
		anchorValid:
			global.anchorValid &&
			runAnchorIsAncestor(global.events, runContext, events, store.getChainAnchor()),
	};
	if (!integrity.anchorValid) integrity.valid = false;

	// Verify sequence continuity: starts at 0, no gaps
	integrity.sequenceValid = true;
	for (let i = 0; i < events.length; i++) {
		if (events[i].sequence !== i) {
			integrity.sequenceValid = false;
			integrity.valid = false;
			integrity.sequenceError = `expected sequence ${i}, got ${events[i].sequence}`;
			break;
		}
	}

	return { runContext, events, integrity };
}

/**
 * Verify hash chain integrity across all runs in chronological order.
 * Returns per-run results plus an overall cross-run chain validity check.
 */
export function verifyDatabaseChain(store: AuditStore): {
	runs: Array<{ runId: string; integrity: ReplayIntegrity }>;
	valid: boolean;
} {
	const runs = store.listRuns().reverse(); // oldest first
	const results: Array<{ runId: string; integrity: ReplayIntegrity }> = [];
	const global = verifyGlobalEvents(store);
	const allEvents = global.events;
	const retentionAnchor = store.getChainAnchor();

	for (const run of runs) {
		const events = allEvents.filter((event) => event.runId === run.runId);
		let sequenceValid = true;
		for (let i = 0; i < events.length; i++) {
			if (events[i].sequence !== i) {
				sequenceValid = false;
				break;
			}
		}
		const anchorValid = runAnchorIsAncestor(allEvents, run, events, retentionAnchor);
		results.push({
			runId: run.runId,
			integrity: {
				valid: global.valid && sequenceValid && anchorValid,
				anchorValid,
				sequenceValid,
				...(sequenceValid ? {} : { sequenceError: "run sequence is not contiguous" }),
			},
		});
	}

	return {
		runs: results,
		valid: global.valid && results.every((result) => result.integrity.valid),
	};
}
