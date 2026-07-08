import { describe, it, expect, afterEach } from "vitest";

import {
	registerOpBaselineTokens,
	unregisterOpBaselineTokens,
	getOpBaselineTokens,
	resetCanonicalRuntime,
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
