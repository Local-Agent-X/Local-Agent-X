import { describe, expect, it } from "vitest";
import { BROADCAST_KEYS, PROTECTED_SETTINGS, RUNTIME_SETTINGS, publicSchema } from "./settings-schema.js";
import { configSchema } from "./config-schema.js";

// Contract mirror of settings-browser-mode.test.ts: supervisedBrowser is a
// runtime, protected, broadcast boolean that DEFAULTS OFF — supervision is the
// opt-in, so existing installs are unchanged (autonomous browser).

describe("supervisedBrowser settings contract", () => {
	it("defaults to false in the config schema (autonomous-by-default)", () => {
		const parsed = configSchema.parse({});
		expect(parsed.supervisedBrowser).toBe(false);
	});

	it("is a runtime + protected + broadcast boolean in the flippable registry", () => {
		const field = publicSchema().find((entry) => entry.field === "supervisedBrowser");
		expect(field).toMatchObject({ type: "boolean", runtime: true });
		expect(RUNTIME_SETTINGS.some((entry) => entry.field === "supervisedBrowser")).toBe(true);
		expect(BROADCAST_KEYS.has("supervisedBrowser")).toBe(true);
		expect(PROTECTED_SETTINGS.has("supervisedBrowser")).toBe(true);
	});
});
