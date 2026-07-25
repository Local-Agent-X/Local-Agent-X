/**
 * EXACT-identity resolution contract for the in-app bridge — the resolver half
 * of the 2026-07-25 class fix.
 *
 * The chain used to open with role+name, a fuzzy substring match against a
 * derived accessible name, and degrade through visible text, an index XPath and
 * stored pixels. A form field that published `id="po-number" name="PO NUMBER"`
 * was therefore resolved by guesswork and, on the live Thrive PO form, not at
 * all. These tests pin that the exact strategy runs FIRST, how it chooses among
 * candidates sharing a key, and that a miss still falls through to the fuzzy
 * chain rather than failing the action.
 *
 * The scripts are in-page strings; they are executed verbatim against a fake
 * DOM, honouring the free-identifier discipline of the isolated world.
 */
import { describe, it, expect } from "vitest";
import { EXACT_MATCH_SRC } from "./in-app-script-helpers.js";
import { resolutionScript } from "./in-app-resolve-scripts.js";
import { stableFillScript } from "./in-app-fill-scripts.js";
import type { DurableRef } from "./observation.js";

// ── Fake DOM ─────────

interface FakeEl {
	tagName: string;
	id?: string;
	attrs: Record<string, string>;
	rect: { left: number; top: number; width: number; height: number };
	textContent: string;
	value?: string;
	isContentEditable: boolean;
	events: string[];
	children: FakeEl[];
	getBoundingClientRect(): { left: number; top: number; width: number; height: number };
	scrollIntoView(): void;
	contains(other: unknown): boolean;
	closest(): null;
	getAttribute(name: string): string | null;
	getRootNode(): Record<string, never>;
	dispatchEvent(e: { type: string }): void;
}

function el(tagName: string, over: Partial<FakeEl> & { attrs?: Record<string, string> } = {}): FakeEl {
	const e: FakeEl = {
		tagName: tagName.toUpperCase(),
		attrs: {},
		rect: { left: 100, top: 100, width: 80, height: 20 },
		textContent: "",
		isContentEditable: false,
		events: [],
		children: [],
		getBoundingClientRect: () => ({ ...e.rect }),
		scrollIntoView: () => { /* no layout in a fake DOM */ },
		contains: (other: unknown) => other === e,
		closest: () => null,
		getAttribute: (name: string) => (name in e.attrs ? e.attrs[name] : null),
		getRootNode: () => ({}),
		dispatchEvent: (ev: { type: string }) => { e.events.push(ev.type); },
		...over,
	};
	return e;
}

/** Selector-aware document: `sel -> elements`. Anything unlisted returns []. */
function fakeDocument(bySelector: Record<string, FakeEl[]>, atPoint: (x: number, y: number) => FakeEl | null) {
	return {
		querySelectorAll: (sel: string) => bySelector[sel] ?? [],
		querySelector: (sel: string) => (bySelector[sel] ?? [])[0] ?? null,
		elementFromPoint: (x: number, y: number) => atPoint(x, y),
		evaluate: () => ({ singleNodeValue: null }),
		documentElement: { clientWidth: 1280, clientHeight: 800 },
	};
}

function mkRef(over: Partial<DurableRef> = {}): DurableRef {
	return {
		id: 12,
		role: "textbox",
		name: "PO NUMBER",
		tag: "INPUT",
		xpath: "",
		rect: { x: 140, y: 110, width: 80, height: 20 },
		...over,
	} as DurableRef;
}

function runResolution(ref: DurableRef, doc: unknown, op: "click" | "fill" = "click"): Record<string, unknown> {
	const fn = new Function(
		"document", "getComputedStyle", "devicePixelRatio", "visualViewport",
		`return ${resolutionScript(ref, op)}`,
	);
	return fn(doc, () => ({ visibility: "visible", display: "block" }), 1, { scale: 1 }) as Record<string, unknown>;
}

// ── exactMatch: candidate choice ─────────

type ExactMatch = (
	roots: Array<{ doc: { querySelectorAll(sel: string): FakeEl[] } }>,
	sels: Array<{ via: string; sel: string; key: string }>,
	vis: (el: FakeEl) => boolean,
	finish: (el: FakeEl, root: unknown, via: string) => Record<string, unknown> | null,
	cx: number,
	cy: number,
) => Record<string, unknown> | null;

const exactMatch = new Function(`return ${EXACT_MATCH_SRC}`)() as ExactMatch;
const alwaysVisible = () => true;
const resolves = (el: FakeEl, _root: unknown, via: string) => ({ found: true, via, el });

describe("exactMatch candidate choice", () => {
	it("resolves a unique match and stamps the key that found it", () => {
		const field = el("input");
		const roots = [{ doc: fakeDocument({ 'input[id="po-number"]': [field] }, () => null) }];
		const hit = exactMatch(roots, [{ via: "id", sel: 'input[id="po-number"]', key: 'id="po-number"' }], alwaysVisible, resolves, 0, 0);
		expect(hit).toMatchObject({ found: true, via: "exact", key: 'id="po-number"', el: field });
	});

	it("picks the candidate NEAREST the observed centre when a key is shared (radio group)", () => {
		// Three radios share name="shipping"; the ref was observed over the third.
		const radios = [0, 1, 2].map((i) => el("input", { rect: { left: 100, top: 100 + i * 40, width: 20, height: 20 } }));
		const roots = [{ doc: fakeDocument({ 'input[name="shipping"]': radios }, () => null) }];
		const hit = exactMatch(roots, [{ via: "name", sel: 'input[name="shipping"]', key: 'name="shipping"' }], alwaysVisible, resolves, 110, 190);
		expect((hit as { el: FakeEl }).el).toBe(radios[2]);
	});

	it("moves to the next selector when the stronger one matches nothing", () => {
		const field = el("input");
		const roots = [{ doc: fakeDocument({ 'input[name="PO NUMBER"]': [field] }, () => null) }];
		const hit = exactMatch(
			roots,
			[
				{ via: "id", sel: 'input[id="gone"]', key: 'id="gone"' },
				{ via: "name", sel: 'input[name="PO NUMBER"]', key: 'name="PO NUMBER"' },
			],
			alwaysVisible, resolves, 0, 0,
		);
		expect(hit).toMatchObject({ key: 'name="PO NUMBER"' });
	});

	it("skips invisible candidates rather than resolving to a hidden duplicate", () => {
		const hidden = el("input");
		const shown = el("input");
		const roots = [{ doc: fakeDocument({ 'input[name="q"]': [hidden, shown] }, () => null) }];
		const hit = exactMatch(roots, [{ via: "name", sel: 'input[name="q"]', key: 'name="q"' }], (e) => e === shown, resolves, 0, 0);
		expect((hit as { el: FakeEl }).el).toBe(shown);
	});

	it("returns null when finish rejects the candidate, so the fuzzy chain still gets its turn", () => {
		const field = el("input");
		const roots = [{ doc: fakeDocument({ 'input[id="x"]': [field] }, () => null) }];
		const hit = exactMatch(roots, [{ via: "id", sel: 'input[id="x"]', key: 'id="x"' }], alwaysVisible, () => null, 0, 0);
		expect(hit).toBeNull();
	});

	it("survives a selector the engine rejects instead of throwing the whole resolution", () => {
		const roots = [{ doc: { querySelectorAll: () => { throw new Error("bad selector"); } } }];
		expect(() => exactMatch(roots, [{ via: "id", sel: "[", key: "id" }], alwaysVisible, resolves, 0, 0)).not.toThrow();
	});
});

// ── resolutionScript: strategy ORDER ─────────

describe("resolutionScript strategy order", () => {
	it("resolves the PO field by its exact id BEFORE trying the fuzzy role+name match", () => {
		const field = el("input", { attrs: { id: "po-number", name: "PO NUMBER" } });
		// A decoy the role+name strategy would have picked first: same fuzzy name,
		// earlier in the role sweep. Only the exact strategy tells them apart.
		const decoy = el("input", { attrs: { name: "PO NUMBER (old)" } });
		const doc = fakeDocument(
			{
				'input[id="po-number"]': [field],
				'input,textarea,[role="textbox"],[contenteditable="true"],[contenteditable=""]': [decoy, field],
			},
			() => field,
		);
		const out = runResolution(mkRef({ ids: { id: "po-number", name: "PO NUMBER" } }), doc, "fill");
		expect(out.found).toBe(true);
		expect(out.via).toBe("exact");
		expect(out.key).toBe('id="po-number"');
	});

	it("falls through to role+name when the exact candidate is occluded", () => {
		const field = el("input", { attrs: { id: "po-number" } });
		const overlay = el("div", { attrs: { id: "modal-backdrop" } });
		const other = el("input", { attrs: { name: "PO NUMBER" }, rect: { left: 400, top: 400, width: 80, height: 20 } });
		const doc = fakeDocument(
			{
				'input[id="po-number"]': [field],
				'input,textarea,[role="textbox"],[contenteditable="true"],[contenteditable=""]': [other],
			},
			(x) => (x < 300 ? overlay : other),
		);
		const out = runResolution(mkRef({ ids: { id: "po-number" } }), doc, "fill");
		expect(out.via).toBe("role");
	});

	it("reports the occluder when EVERY strategy is intercepted", () => {
		const field = el("input", { attrs: { id: "po-number" } });
		const overlay = el("div", { id: "cookie-wall" });
		const doc = fakeDocument({ 'input[id="po-number"]': [field] }, () => overlay);
		const out = runResolution(mkRef({ ids: { id: "po-number" }, role: "", name: "" }), doc, "fill");
		expect(out.found).toBe(false);
		expect((out.occluded as string[]).join()).toContain("exact:div#cookie-wall");
	});

	it("emits NO exact strategy for a ref with no durable identity (unchanged behaviour)", () => {
		expect(resolutionScript(mkRef(), "click")).toContain('"exact":[]');
	});
});

// ── stableFillScript ─────────

function runStableFill(ref: DurableRef, value: string, doc: unknown): Record<string, unknown> {
	class FakeEvent { constructor(public type: string) {} }
	class NotAnElement { /* nothing is an instance of it, so the native-setter path is skipped */ }
	const fn = new Function(
		"document", "Event", "HTMLInputElement", "HTMLTextAreaElement",
		`return ${stableFillScript(ref, value)}`,
	);
	return fn(doc, FakeEvent, NotAnElement, NotAnElement) as Record<string, unknown>;
}

describe("stableFillScript", () => {
	it("writes to the field the stable key names and fires input+change", () => {
		const field = el("input", { value: "" });
		const doc = fakeDocument({ 'input[id="po-number"]': [field] }, () => null);
		const out = runStableFill(mkRef({ ids: { id: "po-number" } }), "PO-4471", doc);
		expect(out).toEqual({ ok: true, key: 'id="po-number"' });
		expect(field.value).toBe("PO-4471");
		expect(field.events).toEqual(["input", "change"]);
	});

	it("never echoes the value back — a fill result must not carry field contents", () => {
		const field = el("input", { value: "" });
		const doc = fakeDocument({ 'input[id="secret"]': [field] }, () => null);
		const out = runStableFill(mkRef({ ids: { id: "secret" } }), "hunter2", doc);
		expect(JSON.stringify(out)).not.toContain("hunter2");
	});

	it("refuses a file input — only the human can drive a native picker", () => {
		const field = el("input", { attrs: { type: "file" } });
		const doc = fakeDocument({ 'input[id="upload"]': [field] }, () => null);
		expect(runStableFill(mkRef({ ids: { id: "upload" } }), "x", doc)).toEqual({ ok: false, error: "file-input" });
	});

	it("reports not-found rather than writing to some other element", () => {
		const doc = fakeDocument({}, () => null);
		expect(runStableFill(mkRef({ ids: { id: "gone" } }), "x", doc)).toEqual({ ok: false, error: "not-found" });
	});
});
