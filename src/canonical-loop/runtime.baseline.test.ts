import { describe, it, expect, afterEach } from "vitest";

import {
	registerOpBaselineTokens,
	unregisterOpBaselineTokens,
	getOpBaselineTokens,
	getLearnedProtocolEnvelopeForOp,
	getToolsForOp,
	registerLearnedProtocolEnvelopeForOp,
	registerRuntimeCleanupForOp,
	registerToolDispatcherForOp,
	registerToolsForOp,
	releaseRuntimeSurfaceForRetry,
	resetCanonicalRuntime,
	unregisterToolDispatcherForOp,
} from "./runtime.js";

afterEach(() => resetCanonicalRuntime());

describe("op baseline-token registry", () => {
	it("returns 0 for an unregistered op (agent/background ops size unchanged)", () => {
		expect(getOpBaselineTokens("op_never_registered")).toBe(0);
	});

	it("stores and resolves a registered baseline", () => {
		registerOpBaselineTokens("op_a", 147_000);
		expect(getOpBaselineTokens("op_a")).toBe(147_000);
	});

	it("unregister drops the entry back to 0 (no leak across ops)", () => {
		registerOpBaselineTokens("op_b", 90_000);
		unregisterOpBaselineTokens("op_b");
		expect(getOpBaselineTokens("op_b")).toBe(0);
	});

	it("resetCanonicalRuntime clears all baselines", () => {
		registerOpBaselineTokens("op_c", 50_000);
		resetCanonicalRuntime();
		expect(getOpBaselineTokens("op_c")).toBe(0);
	});
});

describe("recovered runtime retry cleanup", () => {
	it("preserves durable learned authority and runtime identity across fail-then-recover", () => {
		const opId = "op_retry_cleanup";
		const envelope = {
			slug: "exact-protocol",
			versionId: "version-1",
			candidateId: "candidate-1",
			allowedTools: ["read"],
		};
		const runtimeIdentity = JSON.stringify({
			provider: "local",
			model: "exact-model",
			target: { runtimeId: "ollama", endpointFingerprint: "a".repeat(64) },
		});
		registerLearnedProtocolEnvelopeForOp(opId, envelope);
		const before = Buffer.from(JSON.stringify(getLearnedProtocolEnvelopeForOp(opId)));
		let cleanupCount = 0;
		registerToolDispatcherForOp(opId, {} as never);
		registerRuntimeCleanupForOp(opId, () => { cleanupCount += 1; });
		registerToolsForOp(opId, [{ name: "read", description: "read", inputSchema: {} }]);

		releaseRuntimeSurfaceForRetry(opId);
		expect(cleanupCount).toBe(1);
		expect(getToolsForOp(opId)).toEqual([]);
		expect(Buffer.from(JSON.stringify(getLearnedProtocolEnvelopeForOp(opId)))).toEqual(before);
		expect(JSON.stringify(JSON.parse(runtimeIdentity))).toBe(runtimeIdentity);

		registerToolDispatcherForOp(opId, {} as never);
		expect(getLearnedProtocolEnvelopeForOp(opId)).toEqual(envelope);
		unregisterToolDispatcherForOp(opId);
		expect(getLearnedProtocolEnvelopeForOp(opId)).toBeNull();
	});
});
