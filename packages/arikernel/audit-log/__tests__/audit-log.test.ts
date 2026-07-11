import type { Decision, ToolCall, ToolResult } from "@arikernel/core";
import { afterEach, describe, expect, it } from "vitest";
import {
	AuditStore,
	computeHash,
	genesisHash,
	replayRun,
	verifyChain,
	verifyDatabaseChain,
} from "../src/index.js";

function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
	return {
		id: "tc-1",
		runId: "run-1",
		sequence: 0,
		timestamp: new Date().toISOString(),
		principalId: "agent",
		toolClass: "http",
		action: "get",
		parameters: { url: "https://example.com" },
		taintLabels: [],
		...overrides,
	};
}

function makeDecision(overrides: Partial<Decision> = {}): Decision {
	return {
		verdict: "allow",
		matchedRule: null,
		reason: "Allowed by test",
		taintLabels: [],
		timestamp: new Date().toISOString(),
		...overrides,
	};
}

function makeResult(overrides: Partial<ToolResult> = {}): ToolResult {
	return {
		callId: "tc-1",
		success: true,
		data: { content: "test" },
		durationMs: 50,
		taintLabels: [],
		...overrides,
	};
}

let store: AuditStore | null = null;

afterEach(() => {
	store?.close();
	store = null;
});

describe("Hash chain primitives", () => {
	it("genesisHash returns 64 zeros", () => {
		const hash = genesisHash();
		expect(hash).toBe("0".repeat(64));
		expect(hash).toHaveLength(64);
	});

	it("computeHash returns deterministic SHA-256", () => {
		const hash1 = computeHash("hello", genesisHash());
		const hash2 = computeHash("hello", genesisHash());
		expect(hash1).toBe(hash2);
		expect(hash1).toHaveLength(64);
	});

	it("computeHash produces different hashes for different data", () => {
		const hash1 = computeHash("hello", genesisHash());
		const hash2 = computeHash("world", genesisHash());
		expect(hash1).not.toBe(hash2);
	});

	it("computeHash produces different hashes for different previousHash", () => {
		const hash1 = computeHash("hello", genesisHash());
		const hash2 = computeHash("hello", "a".repeat(64));
		expect(hash1).not.toBe(hash2);
	});
});

describe("verifyChain", () => {
	it("valid chain passes", () => {
		const genesis = genesisHash();
		const data1 = "event-1";
		const hash1 = computeHash(data1, genesis);
		const data2 = "event-2";
		const hash2 = computeHash(data2, hash1);

		const result = verifyChain([
			{ hash: hash1, previousHash: genesis, data: data1 },
			{ hash: hash2, previousHash: hash1, data: data2 },
		]);
		expect(result.valid).toBe(true);
		expect(result.brokenAt).toBeUndefined();
	});

	it("detects tampered hash", () => {
		const genesis = genesisHash();
		const data1 = "event-1";
		const hash1 = computeHash(data1, genesis);

		const result = verifyChain([{ hash: "tampered_hash", previousHash: genesis, data: data1 }]);
		expect(result.valid).toBe(false);
		expect(result.brokenAt).toBe(0);
	});

	it("detects broken previousHash link", () => {
		const genesis = genesisHash();
		const data1 = "event-1";
		const hash1 = computeHash(data1, genesis);
		const data2 = "event-2";
		const wrongPrev = "f".repeat(64);
		const hash2 = computeHash(data2, wrongPrev);

		const result = verifyChain([
			{ hash: hash1, previousHash: genesis, data: data1 },
			{ hash: hash2, previousHash: wrongPrev, data: data2 },
		]);
		expect(result.valid).toBe(false);
		expect(result.brokenAt).toBe(1);
	});

	it("empty chain is valid", () => {
		expect(verifyChain([]).valid).toBe(true);
	});
});

describe("AuditStore", () => {
	it("creates in-memory store", () => {
		store = new AuditStore(":memory:");
		expect(store).toBeDefined();
	});

	it("startRun and getRunContext", () => {
		store = new AuditStore(":memory:");
		store.startRun("run-1", "agent", { preset: "safe" });
		const ctx = store.getRunContext("run-1");
		expect(ctx).not.toBeNull();
		expect(ctx?.runId).toBe("run-1");
		expect(ctx?.principalId).toBe("agent");
		expect(ctx?.startPreviousHash).toBeDefined();
	});

	it("getRunContext returns null for unknown run", () => {
		store = new AuditStore(":memory:");
		expect(store.getRunContext("nonexistent")).toBeNull();
	});

	it("append creates event with hash chain", () => {
		store = new AuditStore(":memory:");
		store.startRun("run-1", "agent", {});

		const tc = makeToolCall();
		const decision = makeDecision();
		const event = store.append(tc, decision);

		expect(event.id).toBeDefined();
		expect(event.runId).toBe("run-1");
		expect(event.sequence).toBe(0);
		expect(event.hash).toHaveLength(64);
		expect(event.previousHash).toBe(genesisHash());
	});

	it("append increments sequence per run", () => {
		store = new AuditStore(":memory:");
		store.startRun("run-1", "agent", {});

		const e1 = store.append(makeToolCall(), makeDecision());
		const e2 = store.append(makeToolCall({ id: "tc-2" }), makeDecision());
		const e3 = store.append(makeToolCall({ id: "tc-3" }), makeDecision());

		expect(e1.sequence).toBe(0);
		expect(e2.sequence).toBe(1);
		expect(e3.sequence).toBe(2);
	});

	it("hash chain links events", () => {
		store = new AuditStore(":memory:");
		store.startRun("run-1", "agent", {});

		const e1 = store.append(makeToolCall(), makeDecision());
		const e2 = store.append(makeToolCall({ id: "tc-2" }), makeDecision());

		expect(e2.previousHash).toBe(e1.hash);
	});

	it("appendSystemEvent creates _system event", () => {
		store = new AuditStore(":memory:");
		store.startRun("run-1", "agent", {});

		const event = store.appendSystemEvent("run-1", "agent", "quarantine", "Behavioral trigger", {
			ruleId: "test",
		});
		expect(event.toolCall.toolClass).toBe("_system");
		expect(event.toolCall.action).toBe("quarantine");
		expect(event.decision.verdict).toBe("deny");
	});

	it("queryRun returns events in sequence order", () => {
		store = new AuditStore(":memory:");
		store.startRun("run-1", "agent", {});

		store.append(makeToolCall(), makeDecision());
		store.append(makeToolCall({ id: "tc-2" }), makeDecision());
		store.append(makeToolCall({ id: "tc-3" }), makeDecision());

		const events = store.queryRun("run-1");
		expect(events).toHaveLength(3);
		expect(events[0].sequence).toBe(0);
		expect(events[1].sequence).toBe(1);
		expect(events[2].sequence).toBe(2);
	});

	it("endRun sets event count", () => {
		store = new AuditStore(":memory:");
		store.startRun("run-1", "agent", {});
		store.append(makeToolCall(), makeDecision());
		store.append(makeToolCall({ id: "tc-2" }), makeDecision());
		store.endRun("run-1");

		const ctx = store.getRunContext("run-1");
		expect(ctx?.eventCount).toBe(2);
		expect(ctx?.endedAt).toBeDefined();
	});

	it("listRuns returns all runs", () => {
		store = new AuditStore(":memory:");
		store.startRun("run-1", "agent", {});
		store.startRun("run-2", "agent", {});

		const runs = store.listRuns();
		expect(runs).toHaveLength(2);
	});

	it("stores and retrieves ToolResult", () => {
		store = new AuditStore(":memory:");
		store.startRun("run-1", "agent", {});

		const result = makeResult();
		const event = store.append(makeToolCall(), makeDecision(), result);

		const events = store.queryRun("run-1");
		expect(events[0].result).toBeDefined();
		expect(events[0].result?.success).toBe(true);
		expect(events[0].result?.data).toEqual({ content: "test" });
	});
});

describe("Replay and verification", () => {
	it("replayRun verifies valid chain", () => {
		store = new AuditStore(":memory:");
		store.startRun("run-1", "agent", {});
		store.append(makeToolCall(), makeDecision());
		store.append(makeToolCall({ id: "tc-2" }), makeDecision());
		store.endRun("run-1");

		const result = replayRun(store, "run-1");
		expect(result).not.toBeNull();
		expect(result?.integrity.valid).toBe(true);
		expect(result?.integrity.sequenceValid).toBe(true);
		expect(result?.events).toHaveLength(2);
	});

	it("replayRun returns null for unknown run", () => {
		store = new AuditStore(":memory:");
		expect(replayRun(store, "nonexistent")).toBeNull();
	});

	it("replayRun verifies anchor hash", () => {
		store = new AuditStore(":memory:");
		store.startRun("run-1", "agent", {});
		store.append(makeToolCall(), makeDecision());

		const result = replayRun(store, "run-1");
		expect(result?.integrity.anchorValid).toBe(true);
	});

	it("verifyDatabaseChain validates all runs", () => {
		store = new AuditStore(":memory:");

		store.startRun("run-1", "agent", {});
		store.append(makeToolCall(), makeDecision());
		store.endRun("run-1");

		store.startRun("run-2", "agent", {});
		store.append(makeToolCall({ id: "tc-2", runId: "run-2" }), makeDecision());
		store.endRun("run-2");

		const result = verifyDatabaseChain(store);
		expect(result.valid).toBe(true);
		expect(result.runs).toHaveLength(2);
	});

	it("verifyDatabaseChain reports invalid run", () => {
		store = new AuditStore(":memory:");
		store.startRun("run-1", "agent", {});
		store.endRun("run-1");
		// Empty run — no events, should still be valid

		const result = verifyDatabaseChain(store);
		expect(result.valid).toBe(true);
	});
});

// Regression: audit_log rows grew WITHOUT BOUND — only persistent_taint_events
// had a purge (231MB observed on a long-lived install). purgeEventsBefore must
// remove old closed runs while keeping the retained suffix tamper-evident via
// the recorded retention anchor.
describe("purgeEventsBefore — audit-event retention", () => {
	it("purges old closed runs, keeps open runs, and the retained chain still verifies", () => {
		store = new AuditStore(":memory:");
		store.startRun("run-old", "agent", {});
		store.append(makeToolCall({ id: "a1", runId: "run-old" }), makeDecision());
		store.append(makeToolCall({ id: "a2", runId: "run-old" }), makeDecision());
		store.endRun("run-old");

		store.startRun("run-live", "agent", {});
		store.append(makeToolCall({ id: "b1", runId: "run-live" }), makeDecision());
		store.append(makeToolCall({ id: "b2", runId: "run-live" }), makeDecision());
		// run-live left OPEN: retention must never touch an in-flight run.

		const anchorBefore = store.queryRun("run-old").at(-1)!.hash;

		// retentionMs=0 → cutoff=now → everything already written is "old";
		// only the open run protects its events.
		const purged = store.purgeEventsBefore(0);
		expect(purged.events).toBe(2);
		expect(purged.runs).toBe(1);

		// The anchor is the newest purged event's hash, and the retained
		// suffix (whose first event chains onto it) still verifies.
		expect(store.getChainAnchor()).toBe(anchorBefore);
		expect(store.getRunContext("run-old")).toBeNull();
		expect(store.queryRun("run-live")).toHaveLength(2);
		expect(verifyDatabaseChain(store).valid).toBe(true);
		const replay = replayRun(store, "run-live");
		expect(replay?.integrity.valid).toBe(true);
		expect(replay?.integrity.anchorValid).toBe(true);
	});

	it("is idempotent and a fresh store purges nothing", () => {
		store = new AuditStore(":memory:");
		expect(store.purgeEventsBefore(0)).toEqual({ events: 0, runs: 0 });
		expect(store.getChainAnchor()).toBeNull();

		store.startRun("run-1", "agent", {});
		store.append(makeToolCall(), makeDecision());
		store.endRun("run-1");
		store.purgeEventsBefore(0);
		// Second purge: nothing left to remove, anchor unchanged.
		const anchor = store.getChainAnchor();
		expect(store.purgeEventsBefore(0)).toEqual({ events: 0, runs: 0 });
		expect(store.getChainAnchor()).toBe(anchor);
		expect(verifyDatabaseChain(store).valid).toBe(true);
	});

	it("a long retention window purges nothing", () => {
		store = new AuditStore(":memory:");
		store.startRun("run-1", "agent", {});
		store.append(makeToolCall(), makeDecision());
		store.endRun("run-1");
		expect(store.purgeEventsBefore(7 * 24 * 60 * 60 * 1000)).toEqual({ events: 0, runs: 0 });
		expect(store.queryRun("run-1")).toHaveLength(1);
	});

	it("new runs appended after a purge still verify (chain continues from lastHash)", () => {
		store = new AuditStore(":memory:");
		store.startRun("run-old", "agent", {});
		store.append(makeToolCall({ runId: "run-old" }), makeDecision());
		store.endRun("run-old");
		store.purgeEventsBefore(0);

		store.startRun("run-new", "agent", {});
		store.append(makeToolCall({ id: "n1", runId: "run-new" }), makeDecision());
		store.endRun("run-new");

		expect(verifyDatabaseChain(store).valid).toBe(true);
		expect(replayRun(store, "run-new")?.integrity.valid).toBe(true);
	});
});
