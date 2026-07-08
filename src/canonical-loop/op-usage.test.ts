import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";

import { lastTurnUsage } from "./op-usage.js";
import { insertOpTurn } from "./store.js";
import { opDir } from "../ops/event-log.js";
import type { OpTurnRow } from "./types.js";

// op_turns live under the module-load-fixed OPS_BASE (event-log.ts), so each
// test uses a unique opId and removes its opDir afterwards.
const cleanup: string[] = [];
afterEach(() => {
	for (const id of cleanup.splice(0)) {
		try { rmSync(opDir(id), { recursive: true, force: true }); } catch { /* ignore */ }
	}
});

interface TurnOpts {
	adapterName?: string;
	/** Explicit boolean = stamped row; undefined = pre-marker-era row. */
	viewCompacted?: boolean;
	observedTools?: string[];
}

function turn(opId: string, turnIdx: number, providerPayload: unknown, opts: TurnOpts = {}): OpTurnRow {
	return {
		opId,
		turnIdx,
		providerState: {
			adapterName: opts.adapterName ?? "anthropic",
			adapterVersion: "1",
			providerPayload,
			...(opts.viewCompacted !== undefined ? { viewCompacted: opts.viewCompacted } : {}),
		},
		toolCallSummary: [],
		...(opts.observedTools ? { observedTools: opts.observedTools } : {}),
		terminalReason: null,
		redirectConsumed: false,
		createdAt: "2026-07-07T10:00:00.000Z",
	};
}

const fullUsage = {
	model: "claude-sonnet-4-6", // 200k window
	usageInputTokens: 2_000,
	usageOutputTokens: 200,
	cacheReadTokens: 40_000,
	cacheCreateTokens: 300,
};

/** A row the anchor should accept: stamped uncompacted, full anthropic usage. */
const stamped = { viewCompacted: false } as const;

describe("lastTurnUsage — real context size of the LAST turn with usage", () => {
	it("returns the last turn's usage sum, not the cumulative total", () => {
		const opId = "op_ltu_test_last";
		cleanup.push(opId);
		insertOpTurn(turn(opId, 0, { ...fullUsage, usageInputTokens: 1_000, usageOutputTokens: 100, cacheReadTokens: 0, cacheCreateTokens: 900 }, stamped));
		insertOpTurn(turn(opId, 1, fullUsage, stamped));
		expect(lastTurnUsage(opId)).toEqual({ turnIdx: 1, contextTokens: 42_500 });
	});

	it("skips trailing turns without usage and anchors on the last one that has it", () => {
		const opId = "op_ltu_test_skip";
		cleanup.push(opId);
		insertOpTurn(turn(opId, 0, fullUsage, stamped));
		insertOpTurn(turn(opId, 1, {}, stamped)); // committed turn, no usage recorded
		expect(lastTurnUsage(opId)).toEqual({ turnIdx: 0, contextTokens: 42_500 });
	});

	it("returns null when no turn recorded usage (and for unknown ops)", () => {
		const opId = "op_ltu_test_none";
		cleanup.push(opId);
		insertOpTurn(turn(opId, 0, { model: "m" }));
		expect(lastTurnUsage(opId)).toBeNull();
		expect(lastTurnUsage("op_ltu_test_missing")).toBeNull();
	});

	// Regression (stale-anchor-after-compaction): compaction is EPHEMERAL, so a
	// turn whose request was the compacted view records usage far below the full
	// replay the next turn rebuilds. Anchoring on it would report the context as
	// small, skip re-compaction, and send the over-window history raw.
	it("refuses the anchor when the anchoring turn's view was compacted", () => {
		const opId = "op_ltu_test_compacted";
		cleanup.push(opId);
		insertOpTurn(turn(opId, 0, fullUsage, stamped));
		insertOpTurn(turn(opId, 1, { ...fullUsage, cacheReadTokens: 5_000 }, { viewCompacted: true }));
		expect(lastTurnUsage(opId)).toBeNull();
	});

	it("does not rehabilitate a refused anchor from an earlier turn", () => {
		const opId = "op_ltu_test_no_rehab";
		cleanup.push(opId);
		insertOpTurn(turn(opId, 0, fullUsage, stamped)); // clean, but stale
		insertOpTurn(turn(opId, 1, fullUsage, { viewCompacted: true }));
		expect(lastTurnUsage(opId)).toBeNull();
	});

	// CLI-proxy path: the terminal result frame reports usage summed across
	// in-stream tool iterations (empirically: totals above the model's window
	// on observedTools turns), so it is not a context-size reading.
	it("refuses the anchor when the turn ran provider-side tools in-stream", () => {
		const opId = "op_ltu_test_observed";
		cleanup.push(opId);
		insertOpTurn(turn(opId, 0, fullUsage, { ...stamped, observedTools: ["mcp__lax__glob"] }));
		expect(lastTurnUsage(opId)).toBeNull();
	});

	// "Absent" is not "0": rows persisted before cache capture existed (and any
	// path that drops cache fields) would silently lose the cached prefix.
	it("refuses the anchor when cache fields are missing", () => {
		const opId = "op_ltu_test_nocache";
		cleanup.push(opId);
		insertOpTurn(turn(opId, 0, { model: "claude-sonnet-4-6", usageInputTokens: 5_000, usageOutputTokens: 500 }, stamped));
		expect(lastTurnUsage(opId)).toBeNull();
	});

	// input + cacheRead + cacheCreate + output is only a context size under
	// Anthropic semantics (input EXCLUDES cache). OpenAI-style prompt_tokens
	// INCLUDES cached tokens — the same sum would double-count.
	it("refuses the anchor for non-anthropic adapters", () => {
		const opId = "op_ltu_test_adapter";
		cleanup.push(opId);
		insertOpTurn(turn(opId, 0, fullUsage, { ...stamped, adapterName: "openai-compat" }));
		expect(lastTurnUsage(opId)).toBeNull();
	});
});

describe("lastTurnUsage — era marker and plausibility clamp", () => {
	// The commit choke point stamps viewCompacted as an explicit boolean on
	// EVERY turn. A row without the boolean predates reliable recording —
	// store audit found pre-marker tool-less rows carrying cumulative usage
	// (haiku tool-less turns at 245k+ against a 200k window).
	it("refuses pre-marker-era rows (viewCompacted absent)", () => {
		const opId = "op_ltu_test_era";
		cleanup.push(opId);
		insertOpTurn(turn(opId, 0, fullUsage)); // no stamp at all
		expect(lastTurnUsage(opId)).toBeNull();
	});

	it("anchors on an explicitly-stamped uncompacted row", () => {
		const opId = "op_ltu_test_stamped";
		cleanup.push(opId);
		insertOpTurn(turn(opId, 0, fullUsage, { viewCompacted: false }));
		expect(lastTurnUsage(opId)).toEqual({ turnIdx: 0, contextTokens: 42_500 });
	});

	// Backstop for cumulative rows that slip past the era marker: a context
	// larger than the model's window is physically impossible for one request.
	it("refuses a context total above the model's window", () => {
		const opId = "op_ltu_test_overwindow";
		cleanup.push(opId);
		insertOpTurn(turn(opId, 0, { ...fullUsage, cacheReadTokens: 197_501, usageInputTokens: 1_000, usageOutputTokens: 1_000, cacheCreateTokens: 500 }, stamped)); // 200_001 > 200k
		expect(lastTurnUsage(opId)).toBeNull();
	});

	it("anchors at exactly the window boundary", () => {
		const opId = "op_ltu_test_atwindow";
		cleanup.push(opId);
		insertOpTurn(turn(opId, 0, { ...fullUsage, cacheReadTokens: 197_500, usageInputTokens: 1_000, usageOutputTokens: 1_000, cacheCreateTokens: 500 }, stamped)); // == 200k
		expect(lastTurnUsage(opId)).toEqual({ turnIdx: 0, contextTokens: 200_000 });
	});

	it("refuses when the turn recorded no model — clamp cannot default", () => {
		const opId = "op_ltu_test_nomodel";
		cleanup.push(opId);
		const { model: _unused, ...noModel } = fullUsage;
		insertOpTurn(turn(opId, 0, noModel, stamped));
		expect(lastTurnUsage(opId)).toBeNull();
	});
});
