import { describe, expect, it } from "vitest";
import { DEFAULT_POLICIES, POLICY_SPEC, getPreset, policyRuleSchema } from "../src/index.js";
import type { PresetId } from "../src/index.js";

const rule = (over: Record<string, unknown> = {}) => ({
	id: "r1",
	name: "allow reads",
	priority: 10,
	match: { toolClass: "file", action: "read" },
	decision: "allow",
	reason: "reads are fine",
	...over,
});

describe("policyRuleSchema", () => {
	it("refuses a misspelled match key instead of dropping it (dropped, the rule matches more)", () => {
		expect(policyRuleSchema.safeParse(rule({ match: { toolclass: "file" } })).success).toBe(false);
		expect(policyRuleSchema.safeParse(rule({ match: { parameters: { path: { notin: ["/etc"] } } } })).success).toBe(false);
	});

	it("refuses a misspelled rule key and a misspelled decision", () => {
		expect(policyRuleSchema.safeParse(rule({ decison: "deny" })).success).toBe(false);
		expect(policyRuleSchema.safeParse(rule({ decision: "dney" })).success).toBe(false);
	});

	it("every shipped preset's rules and the defaults pass the strict schema", () => {
		for (const id of Object.keys(POLICY_SPEC.presets)) {
			for (const p of getPreset(id as PresetId).policies) expect(policyRuleSchema.safeParse(p).error).toBeUndefined();
		}
		for (const p of DEFAULT_POLICIES) expect(policyRuleSchema.safeParse(p).error).toBeUndefined();
	});
});
