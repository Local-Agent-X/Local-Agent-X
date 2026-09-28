import { describe, it, expect, afterEach } from "vitest";
import { resolveAnthropicTransport } from "./resolve-transport.js";

const saved = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
	if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
	else process.env.ANTHROPIC_API_KEY = saved;
});

describe("resolveAnthropicTransport", () => {
	// The "anthropic" provider is subscription auth only: a pay-as-you-go key in
	// the environment is never what runs, so it never sizes the window either.
	it("is the subscription lane even with a real API key in the environment", () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-api03-abcdef";
		expect(resolveAnthropicTransport()).toBe("cli");
	});
});
