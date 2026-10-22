import { describe, expect, it } from "vitest";
import { DEFAULT_POLICIES, POLICY_SPEC, TAINTED_CONTENT_SOURCES, TAINT_SOURCES, getPreset, policyRuleSchema } from "../src/index.js";
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

describe("tainted-content sources", () => {
	it("every untrusted-content list in the policy spec is the one shared list", () => {
		const lists: string[][] = [];
		const walk = (v: unknown): void => {
			if (Array.isArray(v)) v.forEach(walk);
			else if (v && typeof v === "object") {
				for (const [k, x] of Object.entries(v)) {
					if (k === "taintSources" && Array.isArray(x)) lists.push(x as string[]);
					else walk(x);
				}
			}
		};
		walk(POLICY_SPEC);
		// The derived-sensitive rules key on their own source; every list naming
		// untrusted content ("web") must be the shared one, credential included.
		const content = lists.filter((l) => l.includes("web"));
		expect(content.length).toBeGreaterThan(0);
		for (const l of lists) expect(l.includes("web") || l.every((s) => s === "derived-sensitive")).toBe(true);
		lists.splice(0, lists.length, ...content);
		for (const l of lists) expect([...l].sort()).toEqual([...TAINTED_CONTENT_SOURCES].sort());
	});

	it("credential material is a tainted-content source and a known label", () => {
		expect(TAINTED_CONTENT_SOURCES).toContain("credential");
		expect(TAINT_SOURCES).toContain("credential");
	});
});
