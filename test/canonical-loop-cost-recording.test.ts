/**
 * Wiring test for the live cost ledger (cost-tracker) <- canonical-loop.
 *
 * cost-tracker's trackUsage() had no production caller, so getTodayCost /
 * getUsageSummary always read 0. cost-recording.ts now subscribes to the
 * canonical event seam and writes one real usage row when an op terminates.
 *
 * Covers:
 *   (a) aggregateOpUsage sums providerPayload usage across multiple seeded
 *       op_turns and resolves the model.
 *   (b) recordCostEvent on a state_changed -> succeeded event for an op with
 *       usage produces a cost record (getTodayCost().costUsd > 0,
 *       getUsageSummary().recordCount === 1).
 *   (c) an op with NO usage payload (FakeAdapter-shaped) produces NO cost
 *       record (recordCount stays 0).
 *
 * Both op-store and the canonical-loop store resolve their on-disk base from
 * getLaxDir() at MODULE LOAD time, so — like cost-tracker-usage.test.ts — we
 * point LAX_DATA_DIR at a fresh temp dir and vi.resetModules() before each
 * dynamic import, so every module binds to the same temp root.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dataDir: string;
let prevDataDir: string | undefined;

beforeEach(() => {
	prevDataDir = process.env.LAX_DATA_DIR;
	dataDir = mkdtempSync(join(tmpdir(), "cost-recording-"));
	process.env.LAX_DATA_DIR = dataDir;
	vi.resetModules(); // rebind OPS_BASE / USAGE_FILE to the fresh temp dir
});

afterEach(() => {
	vi.useRealTimers();
	if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR;
	else process.env.LAX_DATA_DIR = prevDataDir;
	rmSync(dataDir, { recursive: true, force: true });
});

async function loadModules() {
	const store = await import("../src/canonical-loop/store.js");
	const opUsage = await import("../src/canonical-loop/op-usage.js");
	const costRecording = await import("../src/canonical-loop/cost-recording.js");
	const opStore = await import("../src/ops/op-store.js");
	const costTracker = await import("../src/cost-tracker.js");
	return { store, opUsage, costRecording, opStore, costTracker };
}

function makeOp(opId: string, opts: { model?: string; provider?: string; sessionId?: string }) {
	// Minimal Op shape — only the fields the cost path reads matter; the rest
	// are filled with inert defaults so readOp/writeOp round-trip cleanly.
	return {
		id: opId,
		type: "freeform",
		task: "test op",
		contextPack: {
			task: { description: "", successCriteria: [], constraints: [], notWhatToRedo: [] },
			context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" },
			capabilities: {},
			budget: { maxIterations: 1, maxTokens: 1000, maxWallTimeMs: 1000, maxSelfEditCalls: 0 },
			routing: {
				lane: "interactive",
				...(opts.provider ? { preferredProvider: opts.provider } : {}),
				...(opts.model ? { preferredModel: opts.model } : {}),
			},
			secrets: { allowed: [] },
		},
		lane: "interactive",
		retryPolicy: { maxRetries: 0 },
		ownerId: "test",
		visibility: "private",
		status: "completed",
		createdAt: new Date().toISOString(),
		attemptCount: 0,
		canonical: opts.sessionId ? { sessionId: opts.sessionId } : {},
	};
}

function makeTurn(opId: string, turnIdx: number, payload: Record<string, unknown>) {
	return {
		opId,
		turnIdx,
		providerState: {
			adapterName: "test-adapter",
			adapterVersion: "1.0.0",
			providerPayload: payload,
		},
		toolCallSummary: [],
		terminalReason: "done" as const,
		redirectConsumed: false,
		createdAt: new Date().toISOString(),
	};
}

function stateChangedSucceeded(opId: string) {
	return {
		opId,
		seq: 0,
		type: "state_changed" as const,
		ts: new Date().toISOString(),
		body: { from: "running", to: "succeeded", reason: "turn_done" },
	};
}

describe("aggregateOpUsage", () => {
	it("sums providerPayload usage across multiple op_turns and resolves the model", async () => {
		const { store, opUsage, opStore } = await loadModules();
		const opId = "op-agg-1";

		// preferredModel absent on routing → falls back to last turn's payload.model.
		opStore.writeOp(makeOp(opId, { provider: "anthropic" }) as never);
		store.insertOpTurn(makeTurn(opId, 0, {
			model: "claude-opus-4-8",
			usageInputTokens: 100,
			usageOutputTokens: 40,
			cacheReadTokens: 10,
			cacheCreateTokens: 5,
		}) as never);
		store.insertOpTurn(makeTurn(opId, 1, {
			model: "claude-opus-4-8",
			usageInputTokens: 200,
			usageOutputTokens: 60,
			cacheReadTokens: 20,
			cacheCreateTokens: 0,
		}) as never);

		const agg = opUsage.aggregateOpUsage(opId);
		expect(agg.usageInputTokens).toBe(300);
		expect(agg.usageOutputTokens).toBe(100);
		expect(agg.cacheReadTokens).toBe(30);
		expect(agg.cacheCreateTokens).toBe(5);
		expect(agg.sawAnyUsage).toBe(true);
		expect(agg.sawAnyCache).toBe(true);
		expect(agg.model).toBe("claude-opus-4-8");
	});

	it("prefers routing.preferredModel over the turn payload model", async () => {
		const { store, opUsage, opStore } = await loadModules();
		const opId = "op-agg-2";
		opStore.writeOp(makeOp(opId, { model: "claude-sonnet-4-5", provider: "anthropic" }) as never);
		store.insertOpTurn(makeTurn(opId, 0, {
			model: "claude-opus-4-8", // should be overridden by routing.preferredModel
			usageInputTokens: 10,
			usageOutputTokens: 5,
		}) as never);

		const agg = opUsage.aggregateOpUsage(opId);
		expect(agg.model).toBe("claude-sonnet-4-5");
	});

	it("returns zeros (no usage) for an op with no token payload", async () => {
		const { store, opUsage, opStore } = await loadModules();
		const opId = "op-agg-3";
		opStore.writeOp(makeOp(opId, { provider: "fake" }) as never);
		// FakeAdapter-shaped payload: no usage*/cache* fields, no model.
		store.insertOpTurn(makeTurn(opId, 0, { text: "hello" }) as never);

		const agg = opUsage.aggregateOpUsage(opId);
		expect(agg.usageInputTokens).toBe(0);
		expect(agg.usageOutputTokens).toBe(0);
		expect(agg.sawAnyUsage).toBe(false);
		expect(agg.sawAnyCache).toBe(false);
		expect(agg.model).toBe(null);
	});
});

describe("recordCostEvent", () => {
	it("writes a usage row to the cost ledger when a usage-bearing op succeeds", async () => {
		const { store, costRecording, opStore, costTracker } = await loadModules();
		const opId = "op-cost-1";

		opStore.writeOp(makeOp(opId, {
			model: "claude-opus-4-8",
			provider: "anthropic",
			sessionId: "sess-1",
		}) as never);
		store.insertOpTurn(makeTurn(opId, 0, {
			usageInputTokens: 1_000,
			usageOutputTokens: 500,
		}) as never);

		expect(costTracker.getUsageSummary().recordCount).toBe(0);

		costRecording.recordCostEvent(stateChangedSucceeded(opId) as never);

		const summary = costTracker.getUsageSummary();
		expect(summary.recordCount).toBe(1);
		expect(summary.totalInputTokens).toBe(1_000);
		expect(summary.totalOutputTokens).toBe(500);
		expect(summary.bySession["sess-1"]).toBeDefined();
		expect(summary.byModel["claude-opus-4-8"]).toBeDefined();
		expect(costTracker.getTodayCost().costUsd).toBeGreaterThan(0);
	});

	it("writes NO row for an op with no usage payload (e.g. FakeAdapter)", async () => {
		const { store, costRecording, opStore, costTracker } = await loadModules();
		const opId = "op-cost-2";

		opStore.writeOp(makeOp(opId, { provider: "fake", sessionId: "sess-2" }) as never);
		store.insertOpTurn(makeTurn(opId, 0, { text: "no tokens here" }) as never);

		costRecording.recordCostEvent(stateChangedSucceeded(opId) as never);

		expect(costTracker.getUsageSummary().recordCount).toBe(0);
		expect(costTracker.getTodayCost().costUsd).toBe(0);
	});

	it("ignores non-terminal state_changed events", async () => {
		const { store, costRecording, opStore, costTracker } = await loadModules();
		const opId = "op-cost-3";
		opStore.writeOp(makeOp(opId, { model: "claude-opus-4-8", provider: "anthropic", sessionId: "s" }) as never);
		store.insertOpTurn(makeTurn(opId, 0, { usageInputTokens: 50, usageOutputTokens: 10 }) as never);

		costRecording.recordCostEvent({
			opId,
			seq: 0,
			type: "state_changed",
			ts: new Date().toISOString(),
			body: { from: "queued", to: "running", reason: "leased" },
		} as never);

		expect(costTracker.getUsageSummary().recordCount).toBe(0);
	});
});
