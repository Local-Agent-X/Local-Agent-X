/**
 * Contract tests for the in-app isolated-world scripts — executed against a
 * fake DOM via `new Function(...)`, honoring the free-identifier discipline
 * (document / getComputedStyle / devicePixelRatio / visualViewport only).
 *
 * Pins the 2026-07-20 Thrive regression class:
 *   - scrollIntoView must be behavior:"instant" (a smooth-scrolling page
 *     animates past the synchronous re-measure and every strategy
 *     false-positives as "occluded"),
 *   - an occluded miss must NAME the occluder (strategy:element), and
 *   - an in-page throw must surface its real message via checkedScript, not
 *     Electron's generic "Script failed to execute".
 */
import { describe, it, expect, vi } from "vitest";
import { checkedScript } from "./in-app-scripts.js";
import { resolutionScript, textSearchScript } from "./in-app-resolve-scripts.js";
import type { DurableRef } from "./observation.js";

// ── Fake DOM ─────────

interface FakeElement {
	tagName: string;
	id?: string;
	className?: string;
	rect: { left: number; top: number; width: number; height: number };
	scrollCalls: unknown[];
	parent?: FakeElement;
	shadowHost?: FakeElement;
	textContent?: string;
	getBoundingClientRect(): { left: number; top: number; width: number; height: number };
	scrollIntoView(opts: unknown): void;
	contains(other: unknown): boolean;
	closest(sel: string): null;
	getAttribute(name: string): string | null;
	getRootNode(): { host?: FakeElement };
	children: FakeElement[];
	isContentEditable: boolean;
	value?: string;
	/** Present on fake IFRAME elements: the frame's fake document. */
	contentDocument?: unknown;
}

function el(tagName: string, opts: Partial<FakeElement> = {}): FakeElement {
	const e: FakeElement = {
		tagName: tagName.toUpperCase(),
		rect: { left: 100, top: 100, width: 80, height: 20 },
		scrollCalls: [],
		children: [],
		isContentEditable: false,
		getBoundingClientRect: () => ({ ...e.rect }),
		scrollIntoView: (o: unknown) => { e.scrollCalls.push(o); },
		contains: (other: unknown) => {
			let n = other as FakeElement | undefined;
			while (n) {
				if (n === e) return true;
				n = n.parent;
			}
			return false;
		},
		closest: () => null,
		getAttribute: () => null,
		getRootNode: () => (e.shadowHost ? { host: e.shadowHost } : {}),
		...opts,
	};
	return e;
}

interface FakeDoc {
	byRole: FakeElement[];
	atPoint: (x: number, y: number) => FakeElement | null;
	/** Fake IFRAME elements returned for the "iframe, frame" descent query. */
	frames?: FakeElement[];
}

function fakeDocument(cfg: FakeDoc) {
	return {
		querySelectorAll: (sel?: string) => (sel === "iframe, frame" ? cfg.frames ?? [] : cfg.byRole),
		elementFromPoint: (x: number, y: number) => cfg.atPoint(x, y),
		evaluate: () => ({ singleNodeValue: null }),
		documentElement: { clientWidth: 1280, clientHeight: 800 },
	};
}

function fakeIframe(
	inner: unknown,
	src: string,
	rect: { left: number; top: number; width: number; height: number },
): FakeElement {
	return el("iframe", {
		rect,
		contentDocument: inner,
		getAttribute: (name: string) => (name === "src" ? src : null),
	});
}

function runResolution(ref: DurableRef, doc: unknown): unknown {
	const script = resolutionScript(ref, "click");
	const fn = new Function("document", "getComputedStyle", "devicePixelRatio", "visualViewport", `return ${script}`);
	return fn(doc, () => ({ visibility: "visible", display: "block" }), 1, { scale: 1 });
}

function mkRef(over: Partial<DurableRef> = {}): DurableRef {
	return {
		id: 8,
		role: "link",
		name: "Purchase Orders",
		xpath: "",
		rect: { x: 0, y: 0, width: 0, height: 0 },
		...over,
	} as DurableRef;
}

describe("resolutionScript hit-test contract", () => {
	it("resolves a role match whose hit-test lands on the element itself", () => {
		const link = el("a", { textContent: "purchase orders" });
		const doc = fakeDocument({ byRole: [link], atPoint: () => link });
		const out = runResolution(mkRef(), doc) as { found: boolean; via?: string };
		expect(out.found).toBe(true);
		expect(out.via).toBe("role");
	});

	it("scrolls with behavior:'instant' — smooth pages animate past a sync re-measure", () => {
		const link = el("a", { textContent: "purchase orders" });
		const doc = fakeDocument({ byRole: [link], atPoint: () => link });
		runResolution(mkRef(), doc);
		expect(link.scrollCalls[0]).toMatchObject({ behavior: "instant", block: "center", inline: "center" });
	});

	it("NAMES the occluder when the hit-test is intercepted (tag#id / tag.class)", () => {
		const link = el("a", { textContent: "purchase orders" });
		const overlay = el("div", { id: "modal-backdrop" });
		const doc = fakeDocument({ byRole: [link], atPoint: () => overlay });
		const out = runResolution(mkRef(), doc) as { found: boolean; occluded: string[] };
		expect(out.found).toBe(false);
		expect(out.occluded).toContain("role:div#modal-backdrop");
	});

	it("clicks THROUGH a benign overlapper (small unrelated sibling within the target's bounds)", () => {
		// An icon/ripple-style span sitting on top of the link: same footprint,
		// no overlay markers. A human click lands on it — so must ours.
		const link = el("a", { textContent: "purchase orders" });
		const icon = el("span", { className: "btn-icon" });
		const doc = fakeDocument({ byRole: [link], atPoint: () => icon });
		const out = runResolution(mkRef(), doc) as { found: boolean; via?: string; through?: string };
		expect(out.found).toBe(true);
		expect(out.via).toBe("role");
		expect(out.through).toBe("span.btn-icon");
	});

	it("still refuses when the overlapper is overlay-like even if geometrically small", () => {
		const link = el("a", { textContent: "purchase orders" });
		const toast = el("div", { className: "toast-notification" });
		const doc = fakeDocument({ byRole: [link], atPoint: () => toast });
		const out = runResolution(mkRef(), doc) as { found: boolean; occluded: string[] };
		expect(out.found).toBe(false);
		expect(out.occluded).toContain("role:div.toast-notification");
	});

	it("still refuses when the overlapper dwarfs the target (nav bar / banner class)", () => {
		const link = el("a", { textContent: "purchase orders" });
		const banner = el("div", { className: "site-header", rect: { left: 0, top: 80, width: 1280, height: 120 } });
		const doc = fakeDocument({ byRole: [link], atPoint: () => banner });
		const out = runResolution(mkRef(), doc) as { found: boolean; occluded: string[] };
		expect(out.found).toBe(false);
		expect(out.occluded).toContain("role:div.site-header");
	});

	it("pierces shadow DOM: a hit inside a shadow root whose host is the target counts as related", () => {
		const host = el("thrive-nav", { textContent: "purchase orders" });
		const shadowInner = el("span", { shadowHost: host });
		const doc = fakeDocument({ byRole: [host], atPoint: () => shadowInner });
		const out = runResolution(mkRef(), doc) as { found: boolean };
		expect(out.found).toBe(true);
	});

	it("reports stored coords as offscreen when elementFromPoint returns null there", () => {
		const doc = fakeDocument({ byRole: [], atPoint: () => null });
		const out = runResolution(
			mkRef({ rect: { x: 340, y: 912, width: 80, height: 20 } }),
			doc,
		) as { found: boolean; occluded: string[] };
		expect(out.found).toBe(false);
		expect(out.occluded).toContain("coords:offscreen(340,912)");
	});
});

describe("same-origin iframe descent (Stripe/embedded-editor/consent-in-iframe class)", () => {
	function runTextSearch(text: string, doc: unknown): unknown {
		const fn = new Function("document", "getComputedStyle", "devicePixelRatio", "visualViewport", `return ${textSearchScript(text)}`);
		return fn(doc, () => ({ visibility: "visible", display: "block" }), 1, { scale: 1 });
	}

	it("resolves a frame ref inside its src-matching iframe and OFFSETS coords to main-page space", () => {
		const target = el("a", { textContent: "purchase orders" });
		const inner = fakeDocument({ byRole: [target], atPoint: () => target });
		const frame = fakeIframe(inner, "https://pay.example/embed", { left: 300, top: 200, width: 600, height: 400 });
		const doc = fakeDocument({ byRole: [], atPoint: () => null, frames: [frame] });
		const out = runResolution(mkRef({ frameUrl: "https://pay.example/embed" }), doc) as {
			found: boolean; via?: string; x?: number; y?: number;
		};
		expect(out.found).toBe(true);
		expect(out.via).toBe("role");
		// target center (140,110) + iframe offset (300,200) — browserInput needs MAIN-page coords
		expect(out.x).toBe(440);
		expect(out.y).toBe(310);
	});

	it("falls back to OTHER same-origin frames when no src matches (frame navigated after extract)", () => {
		const target = el("a", { textContent: "purchase orders" });
		const inner = fakeDocument({ byRole: [target], atPoint: () => target });
		const frame = fakeIframe(inner, "https://pay.example/v2", { left: 50, top: 60, width: 600, height: 400 });
		const doc = fakeDocument({ byRole: [], atPoint: () => null, frames: [frame] });
		const out = runResolution(mkRef({ frameUrl: "https://pay.example/v1" }), doc) as {
			found: boolean; via?: string; x?: number; y?: number;
		};
		expect(out.found).toBe(true);
		expect(out.x).toBe(190); // 140 + 50
		expect(out.y).toBe(170); // 110 + 60
	});

	it("a main-frame ref (no frameUrl) never searches iframe documents", () => {
		const target = el("a", { textContent: "purchase orders" });
		const inner = fakeDocument({ byRole: [target], atPoint: () => target });
		const frame = fakeIframe(inner, "https://pay.example/embed", { left: 300, top: 200, width: 600, height: 400 });
		const doc = fakeDocument({ byRole: [], atPoint: () => null, frames: [frame] });
		const out = runResolution(mkRef(), doc) as { found: boolean };
		expect(out.found).toBe(false);
	});

	it("skips a cross-origin frame whose contentDocument access THROWS", () => {
		const hostile = el("iframe", {
			rect: { left: 0, top: 0, width: 600, height: 400 },
			getAttribute: (name: string) => (name === "src" ? "https://bank.example/login" : null),
		});
		Object.defineProperty(hostile, "contentDocument", { get() { throw new Error("cross-origin"); } });
		const doc = fakeDocument({ byRole: [], atPoint: () => null, frames: [hostile] });
		const out = runResolution(mkRef({ frameUrl: "https://bank.example/login" }), doc) as { found: boolean };
		expect(out.found).toBe(false); // refused cleanly, no throw
	});

	it("coords fallback DESCENDS through an iframe at the stored point and verifies identity inside it", () => {
		const target = el("button", { textContent: "purchase orders" });
		const inner = fakeDocument({ byRole: [], atPoint: (x, y) => (x === 40 && y === 712 ? target : null) });
		const frame = fakeIframe(inner, "", { left: 300, top: 200, width: 600, height: 720 });
		const doc = fakeDocument({ byRole: [], atPoint: (x, y) => (x === 340 && y === 912 ? frame : null), frames: [frame] });
		const out = runResolution(
			mkRef({ role: "", rect: { x: 340, y: 912, width: 80, height: 20 } }),
			doc,
		) as { found: boolean; via?: string; x?: number; y?: number };
		expect(out.found).toBe(true);
		expect(out.via).toBe("coords");
		expect(out.x).toBe(340); // stored coords are already main-page space
		expect(out.y).toBe(912);
	});

	it("REJECTS a frame candidate whose main-page point is outside the MAIN viewport (offscreen iframe)", () => {
		// Hidden/clipped ad-style iframe parked at x=2000 on a 1280-wide viewport:
		// the frame-local hit-test passes, but the final main-page point is
		// unclickable — the old pre-frame behavior was found:false, keep it.
		const target = el("a", { textContent: "purchase orders" });
		const inner = fakeDocument({ byRole: [target], atPoint: () => target });
		const frame = fakeIframe(inner, "https://ads.example/slot", { left: 2000, top: 0, width: 600, height: 400 });
		const doc = fakeDocument({ byRole: [], atPoint: () => null, frames: [frame] });
		const out = runResolution(mkRef({ frameUrl: "https://ads.example/slot" }), doc) as {
			found: boolean; occluded: string[];
		};
		expect(out.found).toBe(false);
		expect(out.occluded).toContain("role:offscreen-frame(2140,110)");
	});

	it("REFUSES a frame candidate COVERED by a main-document overlay (invisible to the frame-local hit-test)", () => {
		// The modal lives in the MAIN document, stacked over the iframe: the
		// in-frame hit-test passes (it can't see main-doc layers), so the final
		// main-page point must be re-hit-tested in the main document.
		const target = el("a", { textContent: "purchase orders" });
		const inner = fakeDocument({ byRole: [target], atPoint: () => target });
		const frame = fakeIframe(inner, "https://pay.example/embed", { left: 300, top: 200, width: 600, height: 400 });
		const modal = el("div", { id: "modal-backdrop", rect: { left: 0, top: 0, width: 1280, height: 800 } });
		const doc = fakeDocument({ byRole: [], atPoint: () => modal, frames: [frame] });
		const out = runResolution(mkRef({ frameUrl: "https://pay.example/embed" }), doc) as {
			found: boolean; occluded: string[];
		};
		expect(out.found).toBe(false);
		expect(out.occluded).toContain("role:covered-frame:div#modal-backdrop");
	});

	it("ACCEPTS a frame candidate when the main-document hit at the point is the iframe element itself", () => {
		const target = el("a", { textContent: "purchase orders" });
		const inner = fakeDocument({ byRole: [target], atPoint: () => target });
		const frame = fakeIframe(inner, "https://pay.example/embed", { left: 300, top: 200, width: 600, height: 400 });
		const doc = fakeDocument({ byRole: [], atPoint: () => frame, frames: [frame] });
		const out = runResolution(mkRef({ frameUrl: "https://pay.example/embed" }), doc) as {
			found: boolean; x?: number; y?: number;
		};
		expect(out.found).toBe(true);
		expect(out.x).toBe(440);
		expect(out.y).toBe(310);
	});

	it("click_text skips an offscreen-frame text match instead of clicking dead air", () => {
		const btn = el("button", { textContent: "Pay now" });
		const inner = fakeDocument({ byRole: [btn], atPoint: () => btn });
		const frame = fakeIframe(inner, "https://ads.example/slot", { left: 2000, top: 0, width: 600, height: 400 });
		const doc = fakeDocument({ byRole: [], atPoint: () => null, frames: [frame] });
		const out = runTextSearch("Pay now", doc) as { found: boolean };
		expect(out.found).toBe(false);
	});

	it("REFUSES a frame candidate under a MAIN-document modal/backdrop and names the occluder", () => {
		// The frame-local hit-test passes (it cannot see main-doc layers), but
		// the main document has a full-page backdrop stacked over the iframe —
		// clicking would land on the backdrop, not the frame's button.
		const target = el("a", { textContent: "purchase orders" });
		const inner = fakeDocument({ byRole: [target], atPoint: () => target });
		const frame = fakeIframe(inner, "https://pay.example/embed", { left: 300, top: 200, width: 600, height: 400 });
		const backdrop = el("div", { rect: { left: 0, top: 0, width: 1280, height: 800 } });
		const doc = fakeDocument({ byRole: [], atPoint: () => backdrop, frames: [frame] });
		const out = runResolution(mkRef({ frameUrl: "https://pay.example/embed" }), doc) as {
			found: boolean; occluded: string[];
		};
		expect(out.found).toBe(false);
		expect(out.occluded).toContain("role:covered-frame:div");
	});

	it("ACCEPTS a frame candidate under a small cosmetic main-doc overlap (benign rule, same as in-frame)", () => {
		const target = el("a", { textContent: "purchase orders" });
		const inner = fakeDocument({ byRole: [target], atPoint: () => target });
		const frame = fakeIframe(inner, "https://pay.example/embed", { left: 300, top: 200, width: 600, height: 400 });
		// Icon-sized element sitting mostly WITHIN the target's main-page rect
		// (400,300,80,20): ≤2× area, ≥50% inside — benign, click proceeds.
		const icon = el("span", { rect: { left: 430, top: 302, width: 20, height: 16 } });
		const doc = fakeDocument({ byRole: [], atPoint: () => icon, frames: [frame] });
		const out = runResolution(mkRef({ frameUrl: "https://pay.example/embed" }), doc) as {
			found: boolean; via?: string; x?: number; y?: number;
		};
		expect(out).toMatchObject({ found: true, via: "role", x: 440, y: 310 });
	});

	it("click_text skips a frame match covered by a main-document layer", () => {
		const btn = el("button", { textContent: "Pay now" });
		const inner = fakeDocument({ byRole: [btn], atPoint: () => btn });
		const frame = fakeIframe(inner, "https://pay.example/embed", { left: 300, top: 200, width: 600, height: 400 });
		const backdrop = el("div", { rect: { left: 0, top: 0, width: 1280, height: 800 } });
		const doc = fakeDocument({ byRole: [], atPoint: () => backdrop, frames: [frame] });
		const out = runTextSearch("Pay now", doc) as { found: boolean };
		expect(out.found).toBe(false);
	});

	it("click_text finds text living only inside an iframe and returns MAIN-page coords", () => {
		const btn = el("button", { textContent: "Pay now" });
		const inner = fakeDocument({ byRole: [btn], atPoint: () => btn });
		const frame = fakeIframe(inner, "https://pay.example/embed", { left: 300, top: 200, width: 600, height: 400 });
		const doc = fakeDocument({ byRole: [], atPoint: () => null, frames: [frame] });
		const out = runTextSearch("Pay now", doc) as { found: boolean; role?: string; x?: number; y?: number };
		expect(out).toMatchObject({ found: true, role: "button", x: 440, y: 310 });
	});
});

describe("checkedScript error surfacing + clone safety", () => {
	function evalScript(script: string): unknown {
		return new Function(`return ${script}`)();
	}

	it("passes through a normal result untouched", () => {
		expect(evalScript(checkedScript("1 + 1"))).toBe(2);
	});

	it("leaves a string result byte-identical (document.title must not be reshaped)", () => {
		expect(evalScript(checkedScript(`"Purchase Orders — Thrive"`))).toBe("Purchase Orders — Thrive");
	});

	it("round-trips the action-result contract unchanged ({ok, actual, type})", () => {
		expect(evalScript(checkedScript(`({ ok: true, actual: "x", type: "text" })`)))
			.toEqual({ ok: true, actual: "x", type: "text" });
	});

	it("returns the REAL error message when the script throws", () => {
		const out = evalScript(checkedScript(`(() => { throw new Error("boom: null is not an object"); })()`)) as {
			__laxScriptError?: string;
		};
		expect(out.__laxScriptError).toContain("boom: null is not an object");
	});

	it("captures async rejections from promise-returning scripts", async () => {
		const out = (await evalScript(
			checkedScript(`Promise.reject(new Error("async boom"))`),
		)) as { __laxScriptError?: string };
		expect(out.__laxScriptError).toContain("async boom");
	});

	it("sanitizes a resolved promise value too (the async return path crosses the same bridge)", async () => {
		const out = await evalScript(checkedScript(`Promise.resolve(function namedFn() {})`));
		expect(out).toBe("[Function: namedFn]");
	});

	// The Electron bridge structured-clones the RETURN VALUE out of the
	// renderer; an un-cloneable value used to fail the whole action with
	// "An object could not be cloned" (2026-07-25).
	it("describes a DOM element instead of failing the clone — and NEVER leaks its value", () => {
		const out = evalScript(checkedScript(
			`({ nodeType: 1, tagName: "INPUT", id: "email", className: "form-control", value: "hunter2" })`,
		)) as string;
		expect(out).toContain("INPUT");
		expect(out).toContain("email");
		expect(out).toContain("form-control");
		// SECURITY: the descriptor must never carry the field's value —
		// otherwise a clone crash becomes a password read-out.
		expect(out).not.toContain("hunter2");
	});

	it("describes a function result", () => {
		expect(evalScript(checkedScript(`(function clickHandler() {})`))).toBe("[Function: clickHandler]");
		// Array-literal element: JS name inference doesn't apply, so .name is ""
		// — the real nameless case (an arrow bound to the wrapper's own const
		// would inherit that const's name).
		expect(evalScript(checkedScript(`[() => {}][0]`))).toBe("[Function: anonymous]");
	});

	it("survives a circular object without hanging or throwing", () => {
		const out = evalScript(checkedScript(`(() => { const a = { name: "root" }; a.self = a; return a; })()`)) as {
			name: string; self: string;
		};
		expect(out.name).toBe("root");
		expect(out.self).toBe("[circular]");
	});

	it("describes a Window-like host object", () => {
		expect(evalScript(checkedScript(`({ document: {}, location: {} })`))).toBe("[Window]");
	});

	it("substitutes [unreadable] for a property whose getter throws", () => {
		const out = evalScript(checkedScript(
			`(() => { const o = { ok: true }; Object.defineProperty(o, "frame", { enumerable: true, get() { throw new Error("cross-origin"); } }); return o; })()`,
		)) as { ok: boolean; frame: string };
		expect(out).toEqual({ ok: true, frame: "[unreadable]" });
	});

	// THE INVARIANT: for any input structured clone would have accepted, the
	// sanitizer is the identity. A breadth cap here truncated extract.ts's
	// RawElement[] on a dense purchase-order page (>200 elements) AND appended a
	// "[... N more]" STRING as the last entry of a typed array, which
	// ObservationRegistry then processed as an element. Never again.
	it("round-trips a 300-element array of objects with NO truncation and NO injected marker", () => {
		const out = evalScript(checkedScript(
			`Array.from({ length: 300 }, (_, i) => ({ ref: i, tag: "button" }))`,
		)) as unknown[];
		expect(out).toHaveLength(300);
		expect(out.every((e) => typeof e === "object" && e !== null)).toBe(true);
		// The exact regression: the final entry must be an element, not a string.
		expect(typeof out[out.length - 1]).toBe("object");
		expect(out[299]).toEqual({ ref: 299, tag: "button" });
		expect(out).not.toContain("[... 100 more]");
	});

	it("round-trips a flat number array of 250 unchanged", () => {
		const out = evalScript(checkedScript(`Array.from({ length: 250 }, (_, i) => i)`)) as unknown[];
		expect(out).toHaveLength(250);
		expect(out[249]).toBe(249);
	});

	it("keeps all 250 own keys of a wide object", () => {
		const out = evalScript(checkedScript(
			`(() => { const o = {}; for (let i = 0; i < 250; i++) o["k" + i] = i; return o; })()`,
		)) as Record<string, number>;
		expect(Object.keys(out)).toHaveLength(250);
		expect(out.k249).toBe(249);
	});

	// The depth cap exists only to bound recursion, not to limit data; the old
	// value of 6 truncated legitimately nested page structures.
	it("round-trips a structure nested 20 deep (the old depth cap of 6 truncated it)", () => {
		const out = evalScript(checkedScript(
			`(() => { let node = { leaf: "bottom" }; for (let i = 0; i < 20; i++) node = { depth: i, child: node }; return node; })()`,
		));
		let cur = out as Record<string, unknown>;
		for (let i = 0; i < 20; i++) cur = cur.child as Record<string, unknown>;
		expect(cur).toEqual({ leaf: "bottom" });
	});

	it("keeps every entry of a large Map and Set", () => {
		const mapOut = evalScript(checkedScript(
			`(() => { const m = new Map(); for (let i = 0; i < 150; i++) m.set("k" + i, i); return m; })()`,
		)) as Record<string, number>;
		expect(Object.keys(mapOut)).toHaveLength(150);
		const setOut = evalScript(checkedScript(
			`(() => { const s = new Set(); for (let i = 0; i < 250; i++) s.add(i); return s; })()`,
		)) as unknown[];
		expect(setOut).toHaveLength(250);
	});

	// Host objects whose data lives OFF own-enumerable keys: these
	// structured-cloned fine before the sanitizer existed, so degrading them to
	// {} would silently feed the model empty data — worse than a visible crash.
	it("serializes a rect-like host object through toJSON instead of flattening it to {}", () => {
		const out = evalScript(checkedScript(
			`(() => { const r = { toJSON: () => ({ x: 1, width: 2 }) }; return r; })()`,
		));
		expect(out).toEqual({ x: 1, width: 2 });
	});

	it("keeps a Date a Date (toJSON must not turn it into an ISO string)", () => {
		expect(evalScript(checkedScript(`new Date(0)`))).toBeInstanceOf(Date);
	});

	it("describes an Error VALUE by name+message — and never its stack", () => {
		const out = evalScript(checkedScript(`new TypeError("x is undefined")`)) as Record<string, unknown>;
		expect(out).toEqual({ name: "TypeError", message: "x is undefined" });
		// A stack carries page URLs (query params included) into model context.
		expect(Object.keys(out)).not.toContain("stack");
	});

	it("still returns {} for a genuinely empty plain object", () => {
		expect(evalScript(checkedScript(`({})`))).toEqual({});
	});

	it("labels a keyless class instance instead of lying with {}", () => {
		const out = evalScript(checkedScript(
			`(() => { class Rect { get width() { return 5; } } return new Rect(); })()`,
		));
		expect(typeof out).toBe("string");
		expect(out).toContain("object");
	});

	it("keeps nested action results intact (no over-eager flattening)", () => {
		expect(evalScript(checkedScript(`({ found: true, occluded: ["role:div#modal"], rect: { x: 1, y: 2 } })`)))
			.toEqual({ found: true, occluded: ["role:div#modal"], rect: { x: 1, y: 2 } });
	});
});

describe("execChecked", () => {
	it("rethrows an in-page error with its message", async () => {
		vi.resetModules();
		vi.doMock("./bridge-client.js", () => ({
			browserExec: vi.fn(async () => ({ __laxScriptError: "TypeError: x is undefined" })),
			browserCapture: vi.fn(),
		}));
		const { execChecked } = await import("./in-app-observe.js");
		await expect(execChecked("view-1", "1")).rejects.toThrow(/in-page script threw: TypeError: x is undefined/);
		vi.doUnmock("./bridge-client.js");
	});

	it("surfaces invalid selectors through every selector-addressed action", async () => {
		vi.resetModules();
		vi.doMock("./bridge-client.js", () => ({
			browserExec: vi.fn(async () => ({ __laxScriptError: "SyntaxError: invalid selector" })),
			browserCapture: vi.fn(),
		}));
		const { clickSelectorInApp, fillSelectorInApp, selectOptionInApp } =
			await import("./in-app-selector-actions.js");
		await expect(clickSelectorInApp("view-1", "[")).rejects.toThrow(/in-page script threw: SyntaxError: invalid selector/);
		await expect(fillSelectorInApp("view-1", "[", "value")).rejects.toThrow(/in-page script threw: SyntaxError: invalid selector/);
		await expect(selectOptionInApp("view-1", "[", "value")).rejects.toThrow(/in-page script threw: SyntaxError: invalid selector/);
		vi.doUnmock("./bridge-client.js");
	});
});
