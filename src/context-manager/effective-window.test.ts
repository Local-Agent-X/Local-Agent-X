import { describe, it, expect } from "vitest";

import {
	effectiveContextWindow, isAnthropicModel, subscriptionWindow,
	CLI_EFFECTIVE_WINDOW, SUBSCRIPTION_PROVEN_WINDOWS,
} from "./effective-window.js";
import { lookupContextWindow } from "./model-windows.js";

describe("isAnthropicModel", () => {
	it("is true only for claude ids", () => {
		expect(isAnthropicModel("claude-opus-4-8")).toBe(true);
		expect(isAnthropicModel("claude-opus-4-8[1m]")).toBe(true);
		expect(isAnthropicModel("anthropic/claude-sonnet-5")).toBe(true);
		expect(isAnthropicModel("gpt-5.5")).toBe(false);
		expect(isAnthropicModel("gemini-3-pro-preview")).toBe(false);
		expect(isAnthropicModel("grok-4.3")).toBe(false);
	});
});

describe("subscriptionWindow", () => {
	// A proven entry is a floor on the lane's ceiling — never below the
	// conservative fallback, never above what the lane was seen to serve.
	it("is the measured window for models the lane has served past 200k", () => {
		for (const [model, proven] of Object.entries(SUBSCRIPTION_PROVEN_WINDOWS)) {
			expect(proven).toBeGreaterThan(CLI_EFFECTIVE_WINDOW);
			expect(subscriptionWindow(model)).toBe(proven);
		}
	});

	it("resolves aliases to the measured id", () => {
		expect(subscriptionWindow("claude-opus-5[1m]")).toBe(SUBSCRIPTION_PROVEN_WINDOWS["claude-opus-5"]);
		expect(subscriptionWindow("anthropic/claude-opus-5-5")).toBe(SUBSCRIPTION_PROVEN_WINDOWS["claude-opus-5-5"]);
		// Opus 5.5 is not a dated snapshot of Opus 5: its own row, not Opus 5's.
		expect(subscriptionWindow("claude-opus-5-5")).toBe(SUBSCRIPTION_PROVEN_WINDOWS["claude-opus-5-5"]);
	});

	it("is the conservative fallback for a model with no measurement", () => {
		expect(subscriptionWindow("claude-fable-5")).toBe(CLI_EFFECTIVE_WINDOW);
		expect(subscriptionWindow("claude-sonnet-5")).toBe(CLI_EFFECTIVE_WINDOW);
		expect(subscriptionWindow("claude-opus-4-7")).toBe(CLI_EFFECTIVE_WINDOW);
	});
});

describe("effectiveContextWindow", () => {
	// transport omitted → nominal window, byte-identical to lookupContextWindow.
	it("equals the nominal window when transport is omitted", () => {
		for (const m of ["claude-opus-4-8", "claude-opus-4-8[1m]", "claude-sonnet-5", "claude-fable-5", "claude-opus-4-5", "claude-haiku-4-5", "gpt-5.5", "gemini-2.5-pro", "grok-4.3"]) {
			expect(effectiveContextWindow(m)).toBe(lookupContextWindow(m));
		}
	});

	// 1M-rated Anthropic ids the lane has NOT been measured on collapse to the
	// fallback ceiling on the subscription lane.
	it("clamps unmeasured 1M-rated Anthropic models to the fallback ceiling on the cli transport", () => {
		expect(effectiveContextWindow("claude-opus-4-7", "cli")).toBe(CLI_EFFECTIVE_WINDOW);
		expect(effectiveContextWindow("claude-opus-4-7[1m]", "cli")).toBe(CLI_EFFECTIVE_WINDOW);
		expect(effectiveContextWindow("claude-fable-5", "cli")).toBe(CLI_EFFECTIVE_WINDOW);
		expect(effectiveContextWindow("claude-sonnet-5", "cli")).toBe(CLI_EFFECTIVE_WINDOW);
		expect(effectiveContextWindow("claude-sonnet-4-6", "cli")).toBe(CLI_EFFECTIVE_WINDOW);
	});

	// Measured models get the window the lane demonstrably served — still far
	// under the nominal 1M.
	it("sizes measured models on the subscription lane by what it has served", () => {
		expect(effectiveContextWindow("claude-opus-5", "cli")).toBe(425_000);
		expect(effectiveContextWindow("claude-opus-5-5", "cli")).toBe(330_000);
		expect(effectiveContextWindow("claude-opus-4-8", "cli")).toBe(276_000);
		expect(effectiveContextWindow("claude-opus-4-8[1m]", "cli")).toBe(276_000);
		expect(effectiveContextWindow("claude-opus-5", "cli")).toBeLessThan(lookupContextWindow("claude-opus-5"));
	});

	// Base-200k Anthropic models are already at/below the ceiling — no change.
	it("is a no-op for Anthropic models already at or below the fallback ceiling", () => {
		expect(effectiveContextWindow("claude-opus-4-5", "cli")).toBe(200_000);
		expect(effectiveContextWindow("claude-sonnet-4-5", "cli")).toBe(200_000);
		expect(effectiveContextWindow("claude-haiku-4-5", "cli")).toBe(200_000);
	});

	// Direct API honors the full nominal window even on 1M-rated models.
	it("honors the nominal window on the api transport", () => {
		expect(effectiveContextWindow("claude-opus-4-8", "api")).toBe(1_000_000);
		expect(effectiveContextWindow("claude-opus-5-5", "api")).toBe(1_000_000);
		expect(effectiveContextWindow("claude-sonnet-5", "api")).toBe(1_000_000);
	});

	// Transport only shrinks Anthropic windows — non-Anthropic providers are
	// never on the Claude subscription lane, so their windows are untouched.
	it("never clamps non-Anthropic models regardless of transport", () => {
		expect(effectiveContextWindow("gpt-5.5", "cli")).toBe(1_050_000);
		expect(effectiveContextWindow("gpt-5.6-sol", "cli")).toBe(1_050_000);
		expect(effectiveContextWindow("gpt-5.6-luna", "cli")).toBe(1_050_000);
		expect(effectiveContextWindow("gemini-3-pro-preview", "cli")).toBe(1_048_576);
		expect(effectiveContextWindow("grok-4.3", "cli")).toBe(1_000_000);
	});
});
