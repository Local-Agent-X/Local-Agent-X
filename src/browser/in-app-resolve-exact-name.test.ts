// @vitest-environment happy-dom
/**
 * A ref named "Save" clicks the Save button, not an earlier control whose
 * name merely contains "save". Expo's FCM key dialog has a "Choose saved key"
 * tab before its Save button; the role+name strategy took the first button
 * whose name contained the ref's, so both of the agent's Save clicks switched
 * the dialog to the saved-keys tab and nothing was saved (2026-11-08).
 *
 * The resolution script runs verbatim against a happy-dom page laid out like
 * that dialog. happy-dom has no layout, so each element's box comes from its
 * data-box attribute and elementFromPoint answers from those boxes.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ACC_EXACT_SRC, resolutionScript } from "./in-app-resolve-scripts.js";
import type { DurableRef } from "./observation-types.js";

// The DOM happy-dom provides; this project compiles without the DOM lib.
interface Box { left: number; top: number; width: number; height: number }
interface El { getAttribute(n: string): string | null; getBoundingClientRect(): unknown; tagName: string }
const doc = (globalThis as unknown as { document: { body: { innerHTML: string }; querySelectorAll(s: string): El[]; elementFromPoint: unknown } }).document;

function boxOf(el: El): Box | null {
	const raw = el.getAttribute("data-box");
	if (!raw) return null;
	const [left, top, width, height] = raw.split(",").map(Number);
	return { left, top, width, height };
}

function layOut(html: string): void {
	doc.body.innerHTML = html;
	const all = [...doc.querySelectorAll("*")];
	for (const el of all) {
		const b = boxOf(el) ?? { left: 0, top: 0, width: 400, height: 400 };
		(el as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () =>
			({ ...b, x: b.left, y: b.top, right: b.left + b.width, bottom: b.top + b.height });
	}
	// The innermost boxed element under a point, as a browser's hit-test would.
	doc.elementFromPoint = (x: number, y: number) => {
		let best: El | null = null;
		for (const el of all) {
			const b = boxOf(el);
			if (b && x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height) best = el;
		}
		return best;
	};
}

const DIALOG = `
<div role="dialog" data-box="0,0,560,400">
  <button type="button" data-box="20,20,240,32">Upload new key</button>
  <button type="button" data-box="280,20,240,32">Choose saved key</button>
  <input type="file" data-box="20,80,520,40">
  <button type="button" data-box="20,320,240,40">Cancel</button>
  <button type="button" data-box="280,320,240,40">Save</button>
</div>`;

function ref(name: string): DurableRef {
	return {
		id: 41, signature: "s", role: "button", name, tag: "BUTTON", type: "button",
		xpath: "/html/body/div[9]/button[7]", inViewport: true, lastSeen: 0,
		rect: { x: 0, y: 0, width: 0, height: 0 },
	};
}

const run = (src: string) => (0, eval)(src) as { found: boolean; via?: string; x?: number; y?: number };

describe("click resolution prefers an exact name", () => {
	beforeEach(() => layOut(DIALOG));

	it("a ref named Save resolves to the Save button, not the 'Choose saved key' tab before it", () => {
		const out = run(resolutionScript(ref("Save"), "click"));
		expect(out.found).toBe(true);
		expect(out.via).toBe("role");
		// The Save button's centre, not the tab's (400, 36).
		expect([out.x, out.y]).toEqual([400, 340]);
	});

	it("still finds a control by part of its name when nothing is named exactly that", () => {
		const out = run(resolutionScript(ref("Choose saved"), "click"));
		expect(out.found).toBe(true);
		expect([out.x, out.y]).toEqual([400, 36]);
	});
});

describe("ACC_EXACT_SRC", () => {
	const exact = new Function(`return ${ACC_EXACT_SRC}`)() as (el: unknown, lname: string) => boolean;
	const el = (attrs: Record<string, string>, extra: Record<string, unknown> = {}) =>
		({ getAttribute: (n: string) => (n in attrs ? attrs[n] : null), ...extra });

	it("matches a whole name, case-blind and with whitespace collapsed, and never a part of one", () => {
		expect(exact(el({}, { textContent: "  Save \n" }), "save")).toBe(true);
		expect(exact(el({ "aria-label": "Save" }, { textContent: "" }), "save")).toBe(true);
		expect(exact(el({}, { textContent: "Choose saved key" }), "save")).toBe(false);
		expect(exact(el({}, { textContent: "Save" }), "")).toBe(false);
	});
});
