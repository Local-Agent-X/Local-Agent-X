import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// loadAnthropicTokens / isAnthropicCliAuthenticated read the real ~/.lax store
// and ~/.claude; mock them so the branches are deterministic and don't depend
// on the box's auth.
const loadAnthropicTokens = vi.fn();
const isAnthropicCliAuthenticated = vi.fn();
vi.mock("../auth/anthropic.js", () => ({
	loadAnthropicTokens: () => loadAnthropicTokens(),
	isAnthropicCliAuthenticated: () => isAnthropicCliAuthenticated(),
}));

import { resolveAnthropicTransport } from "./resolve-transport.js";

const ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
	loadAnthropicTokens.mockReset();
	loadAnthropicTokens.mockReturnValue(null);
	isAnthropicCliAuthenticated.mockReset();
	isAnthropicCliAuthenticated.mockReturnValue(false);
});
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe("resolveAnthropicTransport", () => {
	// A real pay-as-you-go key, with no subscription sign-in, is the ONLY thing
	// that yields the direct-API (nominal-window) path.
	it("returns 'api' for a real sk-ant-api03 key in env when nothing is signed in", () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-api03-abcdef";
		expect(resolveAnthropicTransport()).toBe("api");
	});

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

	// A key exported for another project must not move LAX off the plan
	// (getAnthropicApiKey's order): a saved sign-in or the Claude credential
	// file wins over the environment key.
	it("prefers a saved subscription sign-in over a real env key", () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-api03-abcdef";
		loadAnthropicTokens.mockReturnValue({ accessToken: "x", method: "oauth", provider: "anthropic" });
		expect(resolveAnthropicTransport()).toBe("cli");
	});

	it("prefers the Claude credential file over a real env key", () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-api03-abcdef";
		isAnthropicCliAuthenticated.mockReturnValue(true);
		expect(resolveAnthropicTransport()).toBe("cli");
	});

	it("returns 'cli' when no env key but a token is saved", () => {
		loadAnthropicTokens.mockReturnValue({ accessToken: "x", method: "token", provider: "anthropic" });
		expect(resolveAnthropicTransport()).toBe("cli");
	});

	it("defaults to 'cli' when nothing is configured", () => {
		expect(resolveAnthropicTransport()).toBe("cli");
	});

	it("defaults to 'cli' if the token store throws", () => {
		loadAnthropicTokens.mockImplementation(() => { throw new Error("fs blip"); });
		expect(resolveAnthropicTransport()).toBe("cli");
	});
});
