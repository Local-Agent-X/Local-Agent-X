import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// loadAnthropicTokens reads the real ~/.lax store; mock it so the no-env
// fallback branches are deterministic and don't depend on the box's auth.
const loadAnthropicTokens = vi.fn();
vi.mock("../auth/anthropic.js", () => ({ loadAnthropicTokens: () => loadAnthropicTokens() }));

import { resolveAnthropicTransport } from "./resolve-transport.js";

const ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
	loadAnthropicTokens.mockReset();
	loadAnthropicTokens.mockReturnValue(null);
});
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe("resolveAnthropicTransport", () => {
	// A real pay-as-you-go key is the ONLY thing that yields the direct-API
	// (nominal-window) path.
	it("returns 'api' for a real sk-ant-api03 key in env", () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-api03-abcdef";
		expect(resolveAnthropicTransport()).toBe("api");
	});

	// Subscription-style env key → CLI proxy.
	it("returns 'cli' for a subscription-style env key (oauth: / sk-ant-oat)", () => {
		process.env.ANTHROPIC_API_KEY = "oauth:tok";
		expect(resolveAnthropicTransport()).toBe("cli");
		process.env.ANTHROPIC_API_KEY = "sk-ant-oat01-xyz";
		expect(resolveAnthropicTransport()).toBe("cli");
	});

	it("returns 'cli' when only ANTHROPIC_OAUTH_TOKEN is set", () => {
		process.env.ANTHROPIC_OAUTH_TOKEN = "tok";
		expect(resolveAnthropicTransport()).toBe("cli");
	});

	// env key precedence: a real api key wins even if a subscription token is
	// also saved (mirrors getAnthropicApiKey's ordering).
	it("prefers the real env key over a saved subscription token", () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-api03-abcdef";
		loadAnthropicTokens.mockReturnValue({ accessToken: "x", method: "oauth", provider: "anthropic" });
		expect(resolveAnthropicTransport()).toBe("api");
	});

	it("returns 'cli' when no env key but a token is saved", () => {
		loadAnthropicTokens.mockReturnValue({ accessToken: "x", method: "token", provider: "anthropic" });
		expect(resolveAnthropicTransport()).toBe("cli");
	});

	// No env key, no saved token: getAnthropicApiKey falls back to the installed
	// claude CLI's own creds (subprocess path). Default to the safe smaller window.
	it("defaults to 'cli' when nothing is configured", () => {
		expect(resolveAnthropicTransport()).toBe("cli");
	});

	it("defaults to 'cli' if the token store throws", () => {
		loadAnthropicTokens.mockImplementation(() => { throw new Error("fs blip"); });
		expect(resolveAnthropicTransport()).toBe("cli");
	});
});
