/**
 * Resolver name-match (ACC_MATCH_SRC) regression. The extractor derives a ref's
 * name from the HTML `name` attribute (extract.ts computeName) for form fields
 * with no accessible name; the resolver MUST be able to match that same name
 * back, or fields like the Thrive `<input id=po-number name="PO NUMBER">` are
 * observed as "PO NUMBER" but fail every resolution strategy. The matcher is
 * an in-page string; we execute it verbatim against fabricated Element nodes.
 */
import { describe, it, expect } from "vitest";
import { ACC_MATCH_SRC } from "./in-app-resolve-scripts.js";

const acc = new Function(`return ${ACC_MATCH_SRC}`)() as (el: unknown) => string;

/** Minimal Element-like node: getAttribute returns known attrs, else "". */
function el(attrs: Record<string, string> = {}, extra: Record<string, unknown> = {}): unknown {
	return { getAttribute: (n: string) => (n in attrs ? attrs[n] : null), ...extra };
}

describe("resolver name-match (ACC_MATCH_SRC)", () => {
	it("matches a field by its HTML name attribute (the po-number bug)", () => {
		// No aria-label, no placeholder, no label, empty value/text — name only.
		const poNumber = el({ name: "PO NUMBER" }, { value: "", textContent: "" });
		expect(acc(poNumber)).toContain("po number");
	});

	it("still matches the accessible-name sources it always did", () => {
		expect(acc(el({ "aria-label": "Save changes" }))).toContain("save changes");
		expect(acc(el({ placeholder: "Search products" }))).toContain("search products");
		expect(acc(el({}, { textContent: "Submit Order" }))).toContain("submit order");
		expect(acc(el({}, { value: "Acme Corp" }))).toContain("acme corp");
	});

	it("includes the title attribute", () => {
		expect(acc(el({ title: "Delete line item" }))).toContain("delete line item");
	});

	it("returns an empty-ish string for a truly nameless element (ui-select focusser)", () => {
		// No identity anywhere → cannot be matched by name (correctly).
		expect(acc(el({}, { value: "", textContent: "" })).trim()).toBe("");
	});

	it("never throws on a bare node without getAttribute", () => {
		expect(() => acc({})).not.toThrow();
		expect(() => acc(null)).not.toThrow();
	});
});
