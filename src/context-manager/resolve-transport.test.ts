import { describe, it, expect } from "vitest";
import { opAnthropicTransport, resolveAnthropicTransport } from "./resolve-transport.js";

describe("resolveAnthropicTransport", () => {
	// The lane follows the credential the op was admitted with, never the
	// environment: a key `setx`-exported for another project sizes nothing.
	it("is the api lane only for a key saved in LAX's secrets store", () => {
		expect(resolveAnthropicTransport("secrets-store")).toBe("api");
	});

	it("is the subscription lane for a sign-in, an env key, and the unknown", () => {
		expect(resolveAnthropicTransport("oauth")).toBe("cli");
		expect(resolveAnthropicTransport("env")).toBe("cli");
		expect(resolveAnthropicTransport("config")).toBe("cli");
		expect(resolveAnthropicTransport("sentinel")).toBe("cli");
		expect(resolveAnthropicTransport(undefined)).toBe("cli");
	});
});

describe("opAnthropicTransport", () => {
	it("reads the sealed delegated runtime first, then the routing pack", () => {
		expect(opAnthropicTransport({
			runtimeDescriptor: { authSource: "secrets-store" },
			contextPack: { routing: { authSource: "oauth" } },
		})).toBe("api");
		expect(opAnthropicTransport({ contextPack: { routing: { authSource: "secrets-store" } } })).toBe("api");
		expect(opAnthropicTransport({ contextPack: { routing: { authSource: "oauth" } } })).toBe("cli");
	});

	it("is the subscription lane for a legacy descriptor with no credential source", () => {
		expect(opAnthropicTransport({ runtimeDescriptor: { kind: "delegated-op" }, contextPack: { routing: {} } })).toBe("cli");
		expect(opAnthropicTransport({})).toBe("cli");
	});
});
