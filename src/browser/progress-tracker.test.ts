/**
 * No-progress stall guard + enriched page fingerprint — together the fix for
 * "normal browser use looks like the agent spinning".
 *
 * Two units under test:
 *   1. recordProgress / NO_PROGRESS_LIMIT — an unchanged fingerprint increments
 *      a per-session counter and stalls exactly at the limit; ANY change resets
 *      it; an empty ("unknown") fingerprint is skipped, not counted; sessions
 *      are independent.
 *   2. fingerprintPage — the signature must MOVE for the legitimate state
 *      changes the old four-term signature missed (scroll position, a native
 *      checkbox toggle, text typed into an input/textarea), must carry only
 *      lengths/counts (never a field's value), and must return "" when the page
 *      can't be read. We run the REAL production expression string against a
 *      fabricated DOM via `new Function` — mirroring in-app-actions.test.ts's
 *      script-eval harness — so the assertion covers the exact code that ships.
 */
import { describe, expect, it } from "vitest";
import { recordProgress, resetProgress, NO_PROGRESS_LIMIT } from "./progress-tracker.js";
import { fingerprintPage } from "./interactions.js";
import type { Page } from "playwright";

// ── recordProgress / NO_PROGRESS_LIMIT ──────────────────────────────────────
// `sessions` is module-global and persists across tests, so each test uses a
// unique session id rather than relying on a shared reset.

describe("recordProgress — no-progress stall guard", () => {
	it("increments on an unchanged fingerprint and stalls exactly at the limit", () => {
		const s = "stall-basic";
		// First sighting sets the baseline: unchanged 0, never a stall.
		expect(recordProgress(s, "A")).toEqual({ stalled: false, unchanged: 0 });
		// Each identical repeat increments; below the limit it is not yet a stall.
		for (let i = 1; i < NO_PROGRESS_LIMIT; i++) {
			expect(recordProgress(s, "A")).toEqual({ stalled: false, unchanged: i });
		}
		// The NO_PROGRESS_LIMIT-th consecutive unchanged action trips the guard.
		expect(recordProgress(s, "A")).toEqual({ stalled: true, unchanged: NO_PROGRESS_LIMIT });
	});

	it("a changed fingerprint resets the counter — a productive session never stalls", () => {
		const s = "reset-on-change";
		recordProgress(s, "A"); // baseline
		// Walk right up to the edge...
		for (let i = 1; i < NO_PROGRESS_LIMIT; i++) recordProgress(s, "A");
		// ...then the page moves. Fresh baseline, no stall.
		expect(recordProgress(s, "B")).toEqual({ stalled: false, unchanged: 0 });
		// The next identical repeat counts from the NEW baseline, not the old edge.
		expect(recordProgress(s, "B")).toEqual({ stalled: false, unchanged: 1 });
	});

	it("an empty fingerprint is 'unknown' — neither progress nor stall, counter untouched", () => {
		const s = "empty-skips";
		recordProgress(s, "A"); // baseline, unchanged 0
		expect(recordProgress(s, "A")).toEqual({ stalled: false, unchanged: 1 });
		// Page mid-navigation: fingerprint "" — report the current count, don't mutate it.
		expect(recordProgress(s, "")).toEqual({ stalled: false, unchanged: 1 });
		// The count resumes exactly where it was.
		expect(recordProgress(s, "A")).toEqual({ stalled: false, unchanged: 2 });
	});

	it("resetProgress clears the session back to a fresh baseline", () => {
		const s = "explicit-reset";
		recordProgress(s, "A");
		expect(recordProgress(s, "A")).toEqual({ stalled: false, unchanged: 1 });
		resetProgress(s);
		expect(recordProgress(s, "A")).toEqual({ stalled: false, unchanged: 0 });
	});

	it("tracks sessions independently — one session's spin can't stall another", () => {
		const a = "sess-a";
		const b = "sess-b";
		recordProgress(a, "X"); // a baseline
		for (let i = 1; i < NO_PROGRESS_LIMIT; i++) recordProgress(a, "X"); // a one step from the edge
		// b is untouched; it starts its own baseline.
		expect(recordProgress(b, "X")).toEqual({ stalled: false, unchanged: 0 });
		// b's activity didn't advance a — the next unchanged a-action trips it.
		expect(recordProgress(a, "X")).toEqual({ stalled: true, unchanged: NO_PROGRESS_LIMIT });
	});
});

// ── fingerprintPage — enriched progress signature ───────────────────────────
// fingerprintPage passes a JS-string expression to page.evaluate. Here evaluate
// executes that REAL string against a fabricated DOM: the expression references
// location/document/window as free identifiers, which `new Function` injects as
// stand-ins. querySelectorAll returns arrays keyed by the exact selectors the
// expression uses.

interface FakeDom {
	href: string;
	title: string;
	bodyText: string;
	totalElements: number; // querySelectorAll('*').length
	checkedInputs: number; // querySelectorAll('input:checked').length
	fieldValues: string[]; // the value of every <input>/<textarea>
	scrollY: number;
	selectIndices: number[]; // selectedIndex of every <select>
	expandedCount: number; // querySelectorAll('[aria-expanded=true]').length
}

function baseDom(): FakeDom {
	return {
		href: "https://example.test/form",
		title: "Form",
		bodyText: "Name Email Subscribe",
		totalElements: 42,
		checkedInputs: 0,
		fieldValues: ["", ""],
		scrollY: 0,
		selectIndices: [0],
		expandedCount: 0,
	};
}

function fakePage(dom: FakeDom): Page {
	const location = { href: dom.href };
	const document = {
		title: dom.title,
		body: { textContent: dom.bodyText },
		querySelectorAll(selector: string): unknown[] {
			if (selector === "*") return new Array(dom.totalElements).fill(0);
			if (selector === "input:checked") return new Array(dom.checkedInputs).fill(0);
			if (selector === "input,textarea") return dom.fieldValues.map((value) => ({ value }));
			if (selector === "select") return dom.selectIndices.map((selectedIndex) => ({ selectedIndex }));
			if (selector === "[aria-expanded=true]") return new Array(dom.expandedCount).fill(0);
			return [];
		},
	};
	const window = { scrollY: dom.scrollY };
	return {
		evaluate(expr: string): unknown {
			const run = new Function("location", "document", "window", `return (${expr});`) as (
				l: unknown,
				d: unknown,
				w: unknown,
			) => unknown;
			return run(location, document, window);
		},
	} as unknown as Page;
}

describe("fingerprintPage — enriched progress signature", () => {
	it("is stable when nothing changes (identical state ⇒ identical fingerprint)", async () => {
		expect(await fingerprintPage(fakePage(baseDom()))).toBe(await fingerprintPage(fakePage(baseDom())));
	});

	it("MOVES when the page is scrolled (scrollY) — the old signature missed this", async () => {
		const before = await fingerprintPage(fakePage(baseDom()));
		const after = await fingerprintPage(fakePage({ ...baseDom(), scrollY: 600 }));
		expect(after).not.toBe(before);
	});

	it("MOVES when text is typed into an input/textarea (value-length sum)", async () => {
		const before = await fingerprintPage(fakePage(baseDom()));
		const after = await fingerprintPage(fakePage({ ...baseDom(), fieldValues: ["hello", ""] }));
		expect(after).not.toBe(before);
	});

	it("MOVES when a native checkbox is toggled (checked-input count)", async () => {
		const before = await fingerprintPage(fakePage(baseDom()));
		const after = await fingerprintPage(fakePage({ ...baseDom(), checkedInputs: 1 }));
		expect(after).not.toBe(before);
	});

	it("MOVES when a native <select> option changes (selected-index sum)", async () => {
		const before = await fingerprintPage(fakePage(baseDom()));
		const after = await fingerprintPage(fakePage({ ...baseDom(), selectIndices: [2] }));
		expect(after).not.toBe(before);
	});

	it("MOVES when a disclosure toggles aria-expanded (expanded count)", async () => {
		const before = await fingerprintPage(fakePage(baseDom()));
		const after = await fingerprintPage(fakePage({ ...baseDom(), expandedCount: 1 }));
		expect(after).not.toBe(before);
	});

	it("carries only lengths/counts — never a field's actual text", async () => {
		const sig = await fingerprintPage(fakePage({ ...baseDom(), fieldValues: ["s3cr3t-token", ""] }));
		expect(sig).not.toContain("s3cr3t-token");
		// Two different secrets of the SAME length are indistinguishable in the
		// fingerprint — proof it encodes length, not content.
		const a = await fingerprintPage(fakePage({ ...baseDom(), fieldValues: ["a".repeat(12), ""] }));
		const b = await fingerprintPage(fakePage({ ...baseDom(), fieldValues: ["b".repeat(12), ""] }));
		expect(a).toBe(b);
	});

	it("returns '' when the page can't be read (evaluate throws mid-navigation)", async () => {
		const page = {
			evaluate(): never {
				throw new Error("Execution context was destroyed");
			},
		} as unknown as Page;
		expect(await fingerprintPage(page)).toBe("");
	});
});
