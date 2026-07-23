/**
 * Selector-compat contract tests: the host-side compiler, the in-page
 * interpreter (executed against a fake DOM via `new Function`, honoring the
 * document / getComputedStyle free-identifier discipline), and the A1 script
 * integration. Pins the 2026-07-22 Clover regression: the model emitting
 * `li:has-text("Requested Permissions")` must resolve and click instead of
 * dying on `SyntaxError: not a valid selector`.
 */
import { describe, it, expect } from "vitest";
import {
	compileSelector,
	selectorQuery,
	selectorTextHint,
	SELECTOR_ENGINE_FN,
} from "./selector-compat.js";
import { clickScript, fillScript, selectScript, selectFillScript, resolutionScript, textSearchScript } from "./in-app-scripts.js";
import type { DurableRef } from "./observation.js";

// ── Fake DOM ─────────

interface FakeEl {
	tagName: string;
	textContent: string;
	children: FakeEl[];
	clicked: boolean;
	visible: boolean;
	matches: string[];
	getBoundingClientRect(): { left: number; top: number; width: number; height: number };
	scrollIntoView(): void;
	click(): void;
	getAttribute(): null;
	dispatchEvent(evt: unknown): boolean;
	querySelectorAll(sel: string): FakeEl[];
	isContentEditable: boolean;
}

/** `matches` lists the bare css selectors this element answers to (e.g. "li",
 *  "*"). Scoped queries (":scope li") match on the suffix. */
function fel(tagName: string, opts: Partial<FakeEl> = {}): FakeEl {
	const e: FakeEl = {
		tagName: tagName.toUpperCase(),
		textContent: "",
		children: [],
		clicked: false,
		visible: true,
		matches: [tagName.toLowerCase(), "*"],
		getBoundingClientRect: () => ({ left: 10, top: 10, width: e.visible ? 50 : 0, height: e.visible ? 20 : 0 }),
		scrollIntoView: () => {},
		click: () => { e.clicked = true; },
		getAttribute: () => null,
		dispatchEvent: () => true,
		querySelectorAll: (sel: string) => queryList(e.children, sel),
		isContentEditable: false,
		...opts,
	};
	return e;
}

function flatten(els: FakeEl[]): FakeEl[] {
	return els.flatMap((e) => [e, ...flatten(e.children)]);
}

function queryList(els: FakeEl[], sel: string): FakeEl[] {
	const bare = sel.replace(/^:scope\s*>?\s*/, "");
	if (bare === "[") throw new SyntaxError(`'${sel}' is not a valid selector`);
	return flatten(els).filter((e) => e.matches.includes(bare));
}

function fakeDoc(roots: FakeEl[]) {
	const doc = {
		querySelectorAll: (sel: string) => queryList(roots, sel),
		documentElement: { clientWidth: 1280, clientHeight: 800 },
	};
	return doc;
}

function runQuery(selector: string, doc: unknown): unknown {
	const fn = new Function("document", "getComputedStyle", `return ${selectorQuery(selector)}`);
	return fn(doc, () => ({ visibility: "visible", display: "block" }));
}

function runScript(script: string, doc: unknown): unknown {
	// HTMLInputElement / HTMLTextAreaElement are free identifiers in fillScript's
	// native-setter path — only a browser realm defines them. Supply inert
	// stand-ins so the node harness can execute the script; a plain fake element
	// is not an instance of either, so resolution falls to the bare-assignment
	// fallback (which is what these plain-DOM assertions exercise).
	const fn = new Function("document", "getComputedStyle", "HTMLInputElement", "HTMLTextAreaElement", `return ${script}`);
	return fn(
		doc,
		() => ({ visibility: "visible", display: "block" }),
		function HTMLInputElement() {},
		function HTMLTextAreaElement() {},
	);
}

// ── Compiler ─────────

describe("compileSelector", () => {
	it("plain CSS compiles to a verbatim pass-through (no compat)", () => {
		const out = compileSelector("div.card > button[type=submit]");
		expect(out.compat).toBe(false);
		expect(out.stages).toEqual([
			{ kind: "css", segments: [{ css: "div.card > button[type=submit]", child: false, filters: [], visible: false }] },
		]);
	});

	it(`li:has-text("Requested Permissions") → li with a substring filter`, () => {
		const out = compileSelector(`li:has-text("Requested Permissions")`);
		expect(out.compat).toBe(true);
		expect(out.stages).toEqual([
			{ kind: "css", segments: [{ css: "li", child: false, filters: [{ text: "Requested Permissions", exact: false }], visible: false }] },
		]);
	});

	it("text=Log in → unquoted substring text stage; quoted → exact", () => {
		expect(compileSelector("text=Log in").stages).toEqual([{ kind: "text", text: "Log in", exact: false }]);
		expect(compileSelector(`text="Log in"`).stages).toEqual([{ kind: "text", text: "Log in", exact: true }]);
	});

	it(">> chains split into stages (quotes/brackets protected)", () => {
		const out = compileSelector(`div.card >> text=Billing`);
		expect(out.stages).toHaveLength(2);
		expect(out.stages[1]).toEqual({ kind: "text", text: "Billing", exact: false });
		expect(compileSelector(`[data-x=">>"]`).stages).toHaveLength(1);
	});

	it(":text-is is exact, :visible becomes a filter, compound combinators stage-walk", () => {
		const out = compileSelector(`ul.menu li:text-is("Save"):visible`);
		expect(out.stages).toEqual([
			{
				kind: "css",
				segments: [
					{ css: "ul.menu", child: false, filters: [], visible: false },
					{ css: "li", child: false, filters: [{ text: "Save", exact: true }], visible: true },
				],
			},
		]);
	});

	it("has-text argument may contain spaces and quotes-in-parens survive compound splitting", () => {
		const out = compileSelector(`div:has-text("a > b") span`);
		expect(out.stages).toEqual([
			{
				kind: "css",
				segments: [
					{ css: "div", child: false, filters: [{ text: "a > b", exact: false }], visible: false },
					{ css: "span", child: false, filters: [], visible: false },
				],
			},
		]);
	});
});

describe("selectorTextHint", () => {
	it("extracts the target text from has-text and text= forms", () => {
		expect(selectorTextHint(`li:has-text("Requested Permissions")`)).toBe("Requested Permissions");
		expect(selectorTextHint("text=Log in")).toBe("Log in");
		expect(selectorTextHint(`a >> text="Billing"`)).toBe("Billing");
	});
	it("returns null for plain CSS", () => {
		expect(selectorTextHint("div.card > button")).toBeNull();
	});
});

// ── Interpreter (executed) ─────────

describe("SELECTOR_ENGINE_FN (executed against a fake DOM)", () => {
	it("filters :has-text matches case-insensitively", () => {
		const hit = fel("li", { textContent: "Requested Permissions" });
		const miss = fel("li", { textContent: "Other Row" });
		expect(runQuery(`li:has-text("requested permissions")`, fakeDoc([miss, hit]))).toBe(hit);
	});

	it("text= picks the innermost matching element", () => {
		const inner = fel("span", { textContent: "Save changes" });
		const outer = fel("div", { textContent: "Save changes", children: [inner] });
		expect(runQuery("text=Save", fakeDoc([outer]))).toBe(inner);
	});

	it(">> chains query within the previous stage's matches", () => {
		const target = fel("a", { textContent: "Billing" });
		const card = fel("div", { matches: ["div.card", "*"], children: [target] });
		const decoy = fel("a", { textContent: "Billing" });
		expect(runQuery("div.card >> text=Billing", fakeDoc([decoy, card]))).toBe(target);
	});

	it("prefers a visible match over an earlier invisible one", () => {
		const hidden = fel("li", { textContent: "Save", visible: false });
		const shown = fel("li", { textContent: "Save" });
		expect(runQuery(`li:has-text("Save")`, fakeDoc([hidden, shown]))).toBe(shown);
	});

	it("returns null on no match and {bad} on browser-rejected css", () => {
		expect(runQuery("li", fakeDoc([]))).toBeNull();
		const bad = runQuery("[", fakeDoc([fel("li")])) as { bad?: string };
		expect(bad?.bad).toMatch(/not a valid selector/);
	});

	it("engine source keeps the free-identifier discipline (document/getComputedStyle only)", () => {
		expect(SELECTOR_ENGINE_FN).not.toMatch(/\bwindow\b|\blocation\b|\bfetch\b/);
	});
});

// ── A1 script integration ─────────

describe("A1 scripts through the compat engine", () => {
	it(`clickScript(li:has-text(...)) clicks the matching row — the Clover regression`, () => {
		const hit = fel("li", { textContent: "Requested Permissions" });
		const out = runScript(clickScript(`li:has-text("Requested Permissions")`), fakeDoc([hit])) as { ok: boolean };
		expect(out.ok).toBe(true);
		expect(hit.clicked).toBe(true);
	});

	it("clickScript on a browser-invalid selector returns a typed invalid-selector error, not a throw", () => {
		const out = runScript(clickScript("["), fakeDoc([fel("li")])) as { ok: boolean; error?: string };
		expect(out.ok).toBe(false);
		expect(out.error).toMatch(/^invalid-selector: /);
	});

	it("plain-CSS fillScript behavior is unchanged (pass-through)", () => {
		const input = fel("input", { matches: ["input#email", "input", "*"] });
		(input as unknown as { value: string }).value = "";
		const out = runScript(fillScript("input#email", "x@y.z"), fakeDoc([input])) as { ok: boolean; actual?: string };
		expect(out.ok).toBe(true);
		expect(out.actual).toBe("x@y.z");
	});
});

// ── Browser-fix campaign: React-safe fill, <select> case fallback, coords /
//    click_text disambiguation (2026-07-22) ─────────

describe("in-app script correctness fixes", () => {
	function fakeSelect(matches: string[], options: Array<{ value: string; label?: string; text: string }>): FakeEl {
		const sel = fel("select", { matches });
		(sel as unknown as { options: unknown[]; value: string }).options = options;
		(sel as unknown as { value: string }).value = "";
		return sel;
	}

	function mkRef(over: Partial<DurableRef> = {}): DurableRef {
		return { id: 7, role: "button", name: "Save", xpath: "//button", rect: { x: 40, y: 60, width: 30, height: 20 }, ...over } as DurableRef;
	}

	// Bug 1 — React-blind fill: a bare `el.value =` write is deduped by React's
	// value tracker, so onChange never fires (field reads back as filled while
	// framework state stays empty). The script must write through the prototype's
	// native setter (parity with secret-ops.ts fillSecretScript).
	it("fillScript writes through the prototype's native value setter, not bare assignment", () => {
		const script = fillScript("input#email", "hello");
		expect(script).toContain('Object.getOwnPropertyDescriptor(__proto, "value")');
		expect(script).toContain("__desc.set.call(el,");
		expect(script).toContain("HTMLTextAreaElement.prototype");
		// The bare assignment survives exactly once — the else-branch fallback for
		// exotic value-bearing elements.
		expect(script.match(/el\.value = /g) ?? []).toHaveLength(1);
	});

	// Bug 4 — <select> exact-only matching: a model emitting "In Stock" must still
	// resolve an "in stock" option, but exact matches win first.
	it("selectScript matches an option case-insensitively + trimmed when there is no exact match", () => {
		const sel = fakeSelect(["select#c", "select", "*"], [
			{ value: "in_stock", label: "In Stock", text: "In Stock" },
			{ value: "oos", label: "Out of Stock", text: "Out of Stock" },
		]);
		const out = runScript(selectScript("select#c", "  in stock "), fakeDoc([sel])) as { ok: boolean; selected?: string[] };
		expect(out.ok).toBe(true);
		expect(out.selected).toEqual(["in_stock"]);
	});

	it("selectScript prefers an exact match over the case-insensitive fallback", () => {
		const sel = fakeSelect(["select#c", "select", "*"], [
			{ value: "v1", label: "Ready", text: "ready" }, // exact (lowercase) text
			{ value: "v2", label: "READY", text: "READY" }, // would also match loosely
		]);
		const out = runScript(selectScript("select#c", "ready"), fakeDoc([sel])) as { ok: boolean; selected?: string[] };
		expect(out.ok).toBe(true);
		expect(out.selected).toEqual(["v1"]);
	});

	it("selectScript still returns no-matching-option when nothing matches even loosely", () => {
		const sel = fakeSelect(["select#c", "select", "*"], [{ value: "a", label: "Alpha", text: "Alpha" }]);
		const out = runScript(selectScript("select#c", "Zeta"), fakeDoc([sel])) as { ok: boolean; error?: string };
		expect(out.ok).toBe(false);
		expect(out.error).toBe("no-matching-option");
	});

	it("selectFillScript (ref path) shares the same case-insensitive option fallback", () => {
		// selectFillScript resolves by xpath, not a CSS selector, so it isn't driven
		// by this file's selector harness — pin the shared fallback at string level.
		expect(selectFillScript(mkRef(), "In Stock")).toContain(".trim().toLowerCase()");
	});

	// Bug 2 — unconditional coords-fallback success: a non-null elementFromPoint
	// hit was accepted blindly, so a re-rendered target meant clicking whatever
	// unrelated element now sat at the pixels. The hit must still carry the stored
	// role/name, else the chain reports the target moved.
	it("resolutionScript's coords fallback only accepts a hit that still matches the stored identity", () => {
		const script = resolutionScript(mkRef(), "click");
		expect(script).toContain("element moved or was replaced, re-snapshot");
		// Conservative: a blind coords click is accepted ONLY on positive name
		// verification — the stored name present on the visible role-matching
		// element. No stored name, or no match → reject (safe re-snapshot). This
		// prevents a blind click on an unverified hit after a re-layout.
		expect(script).toContain("lname && idEl && vis(idEl) && acc(idEl).includes(lname)");
	});

	// Bug 3 — click_text silent first-match: a tie at the top score clicked the
	// first DOM node with no signal. Prefer an in-viewport candidate and surface
	// the ambiguity so the model can target a specific ref.
	it("textSearchScript breaks score ties toward the viewport and notes the ambiguity", () => {
		const script = textSearchScript("Submit");
		expect(script).toContain("inVp");
		expect(script).toContain("use a ref to target a specific one");
		expect(script).toContain("matched ");
	});
});
