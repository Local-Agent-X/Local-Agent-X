import { describe, it, expect } from "vitest";

import { effectiveContextWindow, isAnthropicModel, CLI_EFFECTIVE_WINDOW } from "./effective-window.js";
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

describe("effectiveContextWindow", () => {
	// transport omitted → nominal window, byte-identical to lookupContextWindow.
	it("equals the nominal window when transport is omitted", () => {
		for (const m of ["claude-opus-4-8", "claude-opus-4-8[1m]", "claude-sonnet-5", "claude-fable-5", "claude-opus-4-5", "claude-haiku-4-5", "gpt-5.5", "gemini-2.5-pro", "grok-4.3"]) {
			expect(effectiveContextWindow(m)).toBe(lookupContextWindow(m));
		}
	});

	// The whole point: 1M-rated Anthropic ids collapse to the CLI ceiling on the
	// subscription path, so compaction thresholds compute against ~200k.
	it("clamps 1M-rated Anthropic models to the CLI ceiling on the cli transport", () => {
		expect(effectiveContextWindow("claude-opus-4-8", "cli")).toBe(CLI_EFFECTIVE_WINDOW);
		expect(effectiveContextWindow("claude-opus-4-8[1m]", "cli")).toBe(CLI_EFFECTIVE_WINDOW);
		expect(effectiveContextWindow("claude-opus-4-7", "cli")).toBe(CLI_EFFECTIVE_WINDOW);
		expect(effectiveContextWindow("claude-fable-5", "cli")).toBe(CLI_EFFECTIVE_WINDOW);
		expect(effectiveContextWindow("claude-sonnet-5", "cli")).toBe(CLI_EFFECTIVE_WINDOW);
	});

	// Base-200k Anthropic models are already at/below the ceiling — no change.
	it("is a no-op for Anthropic models already at or below the CLI ceiling", () => {
		expect(effectiveContextWindow("claude-opus-4-5", "cli")).toBe(200_000);
		expect(effectiveContextWindow("claude-sonnet-4-6", "cli")).toBe(200_000);
		expect(effectiveContextWindow("claude-haiku-4-5", "cli")).toBe(200_000);
	});

	// Direct API honors the full nominal window even on 1M-rated models.
	it("honors the nominal window on the api transport", () => {
		expect(effectiveContextWindow("claude-opus-4-8", "api")).toBe(1_000_000);
		expect(effectiveContextWindow("claude-sonnet-5", "api")).toBe(1_000_000);
	});

	// Transport only shrinks Anthropic windows — non-Anthropic providers are
	// never routed through the Claude CLI proxy, so their windows are untouched.
	it("never clamps non-Anthropic models regardless of transport", () => {
		expect(effectiveContextWindow("gpt-5.5", "cli")).toBe(1_000_000);
		expect(effectiveContextWindow("gemini-3-pro-preview", "cli")).toBe(1_000_000);
		expect(effectiveContextWindow("grok-4.3", "cli")).toBe(131_072);
	});
});
