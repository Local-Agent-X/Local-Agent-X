/**
 * In-app observe + page-script glue:
 *   1. BridgeObservePage — an ADAPTER (not a re-implementation) exposing the
 *      minimal structural subset of Playwright's `Page` the canonical pipeline
 *      consumes (observation/extract/stability/modal/iframe/page-ops/
 *      interactions.fingerprintPage). Ref/diff/format stays in
 *      ObservationRegistry, extraction in extract.ts, shaping in page-ops.ts —
 *      so both backends share one source of truth for observation semantics.
 *   2. The isolated-world page scripts (A1 click/fill/select, the A2 resolution
 *      chain), kept out of the backend for the LOC cap. The KB1 credential
 *      probe lives with the screenshot capture in in-app-page-io.ts.
 *
 * Every script goes through browserExec, which runs ONLY in the view's isolated
 * world (1901, enforced in desktop/src/server-bridge-browser.ts) — page JS can
 * neither tamper with nor observe it. No main-world channel exists here.
 */

import type { Page } from "playwright";
import type { DurableRef } from "./observation.js";
import { browserCapture, browserExec } from "./bridge-client.js";

/** Mutable url/title cache shared with the owning backend — updated on
 *  navigate results and lifecycle pings, read synchronously by url(). */
export interface BridgePageState {
	url: string;
	title: string;
}

const WAIT_POLL_DEFAULT_MS = 150;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

export class BridgeObservePage {
	constructor(
		private readonly viewId: string,
		private readonly state: BridgePageState,
		private readonly closedFn: () => boolean,
	) {}

	url(): string {
		return this.state.url;
	}

	isClosed(): boolean {
		return this.closedFn();
	}

	/** Single embedded document per view — nothing to raise. */
	async bringToFront(): Promise<void> {
		/* no-op */
	}

	/** null → extract/modal detectors fall back to their 1280×800 default. */
	viewportSize(): { width: number; height: number } | null {
		return null;
	}

	async title(): Promise<string> {
		const t = await browserExec(this.viewId, "document.title");
		if (typeof t === "string") this.state.title = t;
		return this.state.title;
	}

	/** ISOLATED-world execution — the only world browserExec offers. */
	async evaluate(script: string): Promise<unknown> {
		return browserExec(this.viewId, script);
	}

	/** The bridge's navigate already settles on did-finish-load /
	 *  did-stop-loading (see desktop/src/server-bridge-browser.ts), so
	 *  load-state waits are satisfied by construction. */
	async waitForLoadState(_state?: string, _opts?: { timeout?: number }): Promise<void> {
		/* settled by the bridge navigate contract */
	}

	/** Poll-based stand-in for Page.waitForFunction, matching how
	 *  stability.ts calls it: (expression, { timeout, polling }). */
	async waitForFunction(
		expression: string,
		opts?: { timeout?: number; polling?: number },
	): Promise<void> {
		const timeout = opts?.timeout ?? 3000;
		const polling = typeof opts?.polling === "number" ? opts.polling : WAIT_POLL_DEFAULT_MS;
		const deadline = Date.now() + timeout;
		for (;;) {
			if (await browserExec(this.viewId, expression)) return;
			if (Date.now() >= deadline) {
				throw new Error(`waitForFunction timed out after ${timeout}ms`);
			}
			await sleep(polling);
		}
	}

	/** page-ops.extractTextFrom seam: $(sel) → handle-with-innerText or null. */
	async $(selector: string): Promise<{ innerText(): Promise<string> } | null> {
		const exists = await browserExec(
			this.viewId,
			`!!document.querySelector(${JSON.stringify(selector)})`,
		);
		if (exists !== true) return null;
		return { innerText: () => this.innerText(selector) };
	}

	async innerText(selector: string): Promise<string> {
		const text = await browserExec(
			this.viewId,
			`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.innerText : ""; })()`,
		);
		return typeof text === "string" ? text : "";
	}

	/** page-ops.screenshotAsBase64 seam — the view's current paint as PNG. */
	async screenshot(_opts?: { type?: string; fullPage?: boolean }): Promise<Buffer> {
		return Buffer.from(await browserCapture(this.viewId), "base64");
	}
}

// ── Simple isolated-world action scripts (A1 — chunk A2 replaces these with
// the full resolution chain + real input events via browserInput) ─────────

export interface ExecActionResult {
	ok: boolean;
	error?: string;
	actual?: unknown;
	type?: string;
	selected?: unknown;
}

export function asExecResult(raw: unknown): ExecActionResult {
	if (raw && typeof raw === "object" && typeof (raw as { ok?: unknown }).ok === "boolean") {
		return raw as ExecActionResult;
	}
	return { ok: false, error: "unexpected exec result shape" };
}

export function clickScript(selector: string): string {
	const sel = JSON.stringify(selector);
	return `(() => {
	const el = document.querySelector(${sel});
	if (!el) return { ok: false, error: "not-found" };
	if (typeof el.click !== "function") return { ok: false, error: "not-clickable" };
	el.scrollIntoView({ block: "center", inline: "center" });
	el.click();
	return { ok: true };
})()`;
}

export function fillScript(selector: string, value: string): string {
	const sel = JSON.stringify(selector);
	const val = JSON.stringify(value);
	return `(() => {
	const el = document.querySelector(${sel});
	if (!el) return { ok: false, error: "not-found" };
	const type = ((el.getAttribute && el.getAttribute("type")) || "").toLowerCase();
	if ("value" in el) el.value = ${val};
	else if (el.isContentEditable) el.textContent = ${val};
	else return { ok: false, error: "not-fillable" };
	el.dispatchEvent(new Event("input", { bubbles: true }));
	el.dispatchEvent(new Event("change", { bubbles: true }));
	return { ok: true, actual: "value" in el ? el.value : el.textContent, type };
})()`;
}

export function selectScript(selector: string, value: string): string {
	const sel = JSON.stringify(selector);
	const val = JSON.stringify(value);
	return `(() => {
	const el = document.querySelector(${sel});
	if (!el) return { ok: false, error: "not-found" };
	if (el.tagName !== "SELECT") return { ok: false, error: "not-a-select" };
	const match = [...el.options].find((o) => o.value === ${val} || o.label === ${val} || o.text === ${val});
	if (!match) return { ok: false, error: "no-matching-option" };
	el.value = match.value;
	el.dispatchEvent(new Event("input", { bubbles: true }));
	el.dispatchEvent(new Event("change", { bubbles: true }));
	return { ok: true, selected: [match.value] };
})()`;
}

// ── A2 resolution-chain scripts (isolated world) ─────────
// Pure string builders consumed by the in-app-actions.ts drivers. They live
// here beside the A1 scripts so all isolated-world page code shares one home;
// the drivers (retry/hit-test-fallthrough/real-input) stay in in-app-actions.ts.

/**
 * The whole ref resolution chain in ONE round-trip: role+name → visible text
 * (click only) → XPath → stored coords (click only). Each candidate is
 * scrolled into view, re-measured, and hit-tested with elementFromPoint; an
 * occluded candidate is recorded in `occluded` and the chain falls through
 * instead of blind-clicking. Returns {found:true, via, x, y, w, h, dpr, zoom,
 * tag, type, editable} (CSS px, viewport-relative) or {found:false, occluded}.
 * Free identifiers are limited to document / getComputedStyle /
 * devicePixelRatio / visualViewport so the contract is unit-testable against a
 * fake DOM (see in-app-actions.test.ts).
 */
export function resolutionScript(ref: DurableRef, op: "click" | "fill"): string {
	const params = JSON.stringify({
		role: ref.role,
		name: ref.name,
		xpath: ref.xpath,
		cx: ref.rect.x,
		cy: ref.rect.y,
		cw: ref.rect.width,
		ch: ref.rect.height,
		op,
	});
	return `(() => {
	const p = ${params};
	const occluded = [];
	const lname = (p.name || "").toLowerCase();
	const env = () => ({
		dpr: (typeof devicePixelRatio === "number" && devicePixelRatio) || 1,
		zoom: (typeof visualViewport !== "undefined" && visualViewport && visualViewport.scale) || 1,
	});
	const vis = (el) => {
		if (!el || !el.getBoundingClientRect) return false;
		const r = el.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) return false;
		const s = getComputedStyle(el);
		return s.visibility !== "hidden" && s.display !== "none";
	};
	const acc = (el) => (((el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("placeholder") || "")) || "")
		+ " " + (el.value || "") + " " + (el.textContent || "")).toLowerCase();
	const ROLE_SEL = {
		button: 'button,[role="button"],input[type="button"],input[type="submit"],input[type="reset"]',
		link: 'a[href],[role="link"]',
		textbox: 'input,textarea,[role="textbox"],[contenteditable="true"],[contenteditable=""]',
		searchbox: 'input[type="search"],[role="searchbox"]',
		combobox: 'select,[role="combobox"]',
		checkbox: 'input[type="checkbox"],[role="checkbox"]',
		radio: 'input[type="radio"],[role="radio"]',
		menuitem: '[role="menuitem"]',
		tab: '[role="tab"]',
	};
	const finish = (el, via, px, py) => {
		if (el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "center" });
		const r = el.getBoundingClientRect();
		const x = typeof px === "number" ? px : r.left + r.width / 2;
		const y = typeof py === "number" ? py : r.top + r.height / 2;
		const hit = document.elementFromPoint(x, y);
		const label = hit && hit.closest ? hit.closest("label") : null;
		const related = !!hit && (hit === el
			|| (el.contains && el.contains(hit))
			|| (hit.contains && hit.contains(el))
			|| (!!label && !!el.id && label.getAttribute("for") === el.id));
		if (!related) { occluded.push(via); return null; }
		const e = env();
		return { found: true, via, x, y, w: r.width, h: r.height, dpr: e.dpr, zoom: e.zoom,
			tag: el.tagName || "",
			type: ((el.getAttribute && el.getAttribute("type")) || "").toLowerCase(),
			editable: el.isContentEditable === true };
	};
	if (p.role && p.name && ROLE_SEL[p.role]) {
		for (const el of document.querySelectorAll(ROLE_SEL[p.role])) {
			if (!vis(el) || !acc(el).includes(lname)) continue;
			const hit = finish(el, "role");
			if (hit) return hit;
			break;
		}
	}
	if (p.op === "click" && p.name) {
		for (const el of document.querySelectorAll("a,button,[role],label,summary,span,div,li,td,th")) {
			if (!vis(el)) continue;
			if (!(el.textContent || "").toLowerCase().includes(lname)) continue;
			let inner = false;
			for (const c of el.children) if ((c.textContent || "").toLowerCase().includes(lname)) { inner = true; break; }
			if (inner) continue;
			const hit = finish(el, "text");
			if (hit) return hit;
			break;
		}
	}
	if (p.xpath) {
		try {
			const el = document.evaluate(p.xpath, document, null, 9, null).singleNodeValue;
			if (el && vis(el)) {
				const hit = finish(el, "xpath");
				if (hit) return hit;
			}
		} catch { /* stale xpath */ }
	}
	if (p.op === "click" && p.cw > 0 && p.ch > 0) {
		const el = document.elementFromPoint(p.cx, p.cy);
		if (el) {
			const e = env();
			return { found: true, via: "coords", x: p.cx, y: p.cy, w: p.cw, h: p.ch, dpr: e.dpr, zoom: e.zoom,
				tag: el.tagName || "", type: ((el.getAttribute && el.getAttribute("type")) || "").toLowerCase(),
				editable: el.isContentEditable === true };
		}
		occluded.push("coords");
	}
	return { found: false, occluded };
})()`;
}

/** clickByText search: clickable elements first (exact matches preferred),
 *  then any innermost visible element containing the text. Occluded
 *  candidates are skipped, never blind-clicked. */
export function textSearchScript(text: string): string {
	return `(() => {
	const q = ${JSON.stringify(text)}.toLowerCase();
	const CLICKABLE = 'a[href],button,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],input[type="submit"],input[type="button"],label';
	const vis = (el) => {
		if (!el || !el.getBoundingClientRect) return false;
		const r = el.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) return false;
		const s = getComputedStyle(el);
		return s.visibility !== "hidden" && s.display !== "none";
	};
	const leafText = (el) => (el.textContent || "").trim().toLowerCase();
	const roleOf = (el) => ((el.getAttribute && el.getAttribute("role")) || ({ A: "link", BUTTON: "button" })[el.tagName] || "");
	const picks = [];
	for (const el of document.querySelectorAll(CLICKABLE)) {
		if (!vis(el)) continue;
		const t = leafText(el);
		if (!t.includes(q)) continue;
		picks.push([t === q ? 5 : 2, el]);
	}
	if (picks.length === 0) {
		for (const el of document.querySelectorAll("*")) {
			if (!vis(el)) continue;
			const t = leafText(el);
			if (!t.includes(q)) continue;
			let inner = false;
			for (const c of el.children) if ((c.textContent || "").toLowerCase().includes(q)) { inner = true; break; }
			if (!inner) picks.push([t === q ? 3 : 0, el]);
		}
	}
	picks.sort((a, b) => b[0] - a[0]);
	for (const pick of picks) {
		const el = pick[1];
		if (el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "center" });
		const r = el.getBoundingClientRect();
		const x = r.left + r.width / 2, y = r.top + r.height / 2;
		const hit = document.elementFromPoint(x, y);
		if (!hit || !(hit === el || (el.contains && el.contains(hit)) || (hit.contains && hit.contains(el)))) continue;
		return { found: true, role: roleOf(el), x, y,
			dpr: (typeof devicePixelRatio === "number" && devicePixelRatio) || 1,
			zoom: (typeof visualViewport !== "undefined" && visualViewport && visualViewport.scale) || 1 };
	}
	return { found: false };
})()`;
}

/** <select> fill: CDP parity — never typed; .value + input/change events. */
export function selectFillScript(ref: DurableRef, value: string): string {
	const params = JSON.stringify({ xpath: ref.xpath, name: ref.name, value });
	return `(() => {
	const p = ${params};
	let el = null;
	if (p.xpath) { try { el = document.evaluate(p.xpath, document, null, 9, null).singleNodeValue; } catch { /* stale */ } }
	if (!el || el.tagName !== "SELECT") {
		const lname = (p.name || "").toLowerCase();
		for (const c of document.querySelectorAll("select")) {
			const acc = (((c.getAttribute("aria-label") || "") + " " + (c.name || "") + " " + (c.id || ""))).toLowerCase();
			if (!lname || acc.includes(lname)) { el = c; break; }
		}
	}
	if (!el || el.tagName !== "SELECT") return { ok: false, error: "not-found" };
	const match = [...el.options].find((o) => o.value === p.value || o.label === p.value || o.text === p.value);
	if (!match) return { ok: false, error: "no-matching-option" };
	el.value = match.value;
	el.dispatchEvent(new Event("input", { bubbles: true }));
	el.dispatchEvent(new Event("change", { bubbles: true }));
	return { ok: true, selected: [match.value] };
})()`;
}

/**
 * The one deliberate cast in the in-app backend. The pipeline is typed against
 * Playwright's `Page` but only consumes the structural subset BridgeObservePage
 * implements. Widening it to a narrower PageLike interface is the right seam but
 * touches observation/extract/stability/page-ops (outside this chunk); until
 * then the cast keeps ONE observation implementation instead of a forked one.
 */
export function asObservePage(adapter: BridgeObservePage): Page {
	return adapter as unknown as Page;
}
