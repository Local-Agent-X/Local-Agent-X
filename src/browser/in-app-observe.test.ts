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

describe("checkedScript error surfacing", () => {
	function evalScript(script: string): unknown {
		return new Function(`return ${script}`)();
	}

	it("passes through a normal result untouched", () => {
		expect(evalScript(checkedScript("1 + 1"))).toBe(2);
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
