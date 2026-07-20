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
import { checkedScript, resolutionScript } from "./in-app-scripts.js";
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
}

function fakeDocument(cfg: FakeDoc) {
	return {
		querySelectorAll: () => cfg.byRole,
		elementFromPoint: (x: number, y: number) => cfg.atPoint(x, y),
		evaluate: () => ({ singleNodeValue: null }),
	};
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
});
