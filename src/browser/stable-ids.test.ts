/**
 * Stable-identifier selector contract. Both resolution chains (in-app bridge
 * and CDP) build their EXACT strategies from stableSelectors, so the order,
 * the tag constraint and the escaping are a shared contract — a divergence
 * here is a silent seam regression between the two backends.
 */
import { describe, it, expect } from "vitest";
import { attrSelector, hasStableIds, isUsableIdValue, stableSelectors } from "./stable-ids.js";

describe("stableSelectors", () => {
	it("orders strategies strongest-first: id, testid, name, placeholder", () => {
		const sels = stableSelectors(
			{ id: "po-number", testId: "po-field", name: "PO NUMBER", placeholder: "Enter PO" },
			"INPUT",
		);
		expect(sels.map((s) => s.via)).toEqual(["id", "testid", "name", "placeholder"]);
	});

	it("constrains each selector to the ref's tag so an INPUT ref can't match its LABEL", () => {
		const [sel] = stableSelectors({ testId: "po-field" }, "INPUT");
		expect(sel.sel.split(",").every((s) => s.startsWith("input["))).toBe(true);
	});

	it("covers every test-hook attribute for one testId value", () => {
		const [sel] = stableSelectors({ testId: "row-3" });
		expect(sel.sel).toContain('[data-testid="row-3"]');
		expect(sel.sel).toContain('[data-test="row-3"]');
		expect(sel.sel).toContain('[data-qa="row-3"]');
		expect(sel.sel).toContain('[data-cy="row-3"]');
	});

	it("resolves the PO field by its HTML name — the attribute getByRole cannot see", () => {
		// <input id="po-number" name="PO NUMBER"> with an empty accessible name:
		// the live shape that made every fill fail on the Thrive PO form.
		const sels = stableSelectors({ id: "po-number", name: "PO NUMBER" }, "INPUT");
		expect(sels[0].sel).toBe('input[id="po-number"]');
		expect(sels[1].sel).toBe('input[name="PO NUMBER"]');
		expect(sels[1].key).toBe('name="PO NUMBER"');
	});

	it("skips a mixed-case (SVG/XML) tag rather than emitting a selector that matches nothing", () => {
		// CSS type selectors are case-sensitive in SVG: `clippath[...]` would
		// silently match no element, turning an exact strategy into a dead one.
		const [sel] = stableSelectors({ id: "mask-1" }, "clipPath");
		expect(sel.sel).toBe('[id="mask-1"]');
	});

	it("returns nothing for a ref with no durable identity", () => {
		expect(stableSelectors(undefined)).toEqual([]);
		expect(stableSelectors({})).toEqual([]);
		expect(hasStableIds({ name: "" })).toBe(false);
		expect(hasStableIds({ name: "vendor" })).toBe(true);
	});
});

describe("attrSelector escaping", () => {
	it("escapes quotes and backslashes so a hostile value can't break out of the selector", () => {
		expect(attrSelector("name", 'say "hi"')).toBe('[name="say \\"hi\\""]');
		expect(attrSelector("id", "a\\b")).toBe('[id="a\\\\b"]');
	});

	it("keeps CSS-significant characters literal — no CSS.escape gymnastics needed", () => {
		// React/Angular emit ids like ":r1:" and "ng-select-2" that break the
		// `#id` form but are perfectly legal inside an attribute selector.
		expect(attrSelector("id", ":r1:")).toBe('[id=":r1:"]');
	});
});

describe("isUsableIdValue", () => {
	it("rejects empties, over-long values, control characters and non-strings", () => {
		expect(isUsableIdValue("")).toBe(false);
		expect(isUsableIdValue("   ")).toBe(false);
		expect(isUsableIdValue("x".repeat(201))).toBe(false);
		expect(isUsableIdValue(`two${String.fromCharCode(10)}lines`)).toBe(false);
		expect(isUsableIdValue(undefined)).toBe(false);
		expect(isUsableIdValue(42)).toBe(false);
	});

	it("accepts an ordinary identifier", () => {
		expect(isUsableIdValue("po-number")).toBe(true);
		expect(isUsableIdValue("  PO NUMBER  ")).toBe(true);
	});
});
