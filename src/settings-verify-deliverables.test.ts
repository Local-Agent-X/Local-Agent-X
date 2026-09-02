import { describe, expect, it } from "vitest";
import { BROADCAST_KEYS, FLIPPABLE_SETTINGS, PROTECTED_SETTINGS, RUNTIME_SETTINGS, publicSchema } from "./settings-schema.js";
import { configSchema } from "./config-schema.js";

// Contract mirror of settings-supervised-browser.test.ts: verifyDeliverables is
// a runtime, broadcast boolean that DEFAULTS ON — the deliverable verification
// pass (one background model run when a task builds a deliverable from external
// data) runs out of the box, and opting out is the explicit choice. NOT
// protected: it's a quality/cost knob, not a user-owned security control, so
// the agent may flip it within the normal autonomy rules.

describe("verifyDeliverables settings contract", () => {
	it("defaults to true in the config schema (verification-on-by-default)", () => {
		const parsed = configSchema.parse({});
		expect(parsed.verifyDeliverables).toBe(true);
	});

	it("is a runtime + broadcast boolean in the flippable registry (not protected)", () => {
		const field = publicSchema().find((entry) => entry.field === "verifyDeliverables");
		expect(field).toMatchObject({ type: "boolean", runtime: true });
		expect(RUNTIME_SETTINGS.some((entry) => entry.field === "verifyDeliverables")).toBe(true);
		expect(BROADCAST_KEYS.has("verifyDeliverables")).toBe(true);
		expect(PROTECTED_SETTINGS.has("verifyDeliverables")).toBe(false);
	});

	it("is flippable: accepts both booleans, rejects non-booleans", () => {
		const setting = FLIPPABLE_SETTINGS.find((entry) => entry.field === "verifyDeliverables");
		expect(setting?.validate.safeParse(true).success).toBe(true);
		expect(setting?.validate.safeParse(false).success).toBe(true);
		expect(setting?.validate.safeParse("true").success).toBe(false);
	});
});
