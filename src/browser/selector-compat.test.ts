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
import { clickScript, fillScript } from "./in-app-scripts.js";

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
	const fn = new Function("document", "getComputedStyle", `return ${script}`);
	return fn(doc, () => ({ visibility: "visible", display: "block" }));
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
