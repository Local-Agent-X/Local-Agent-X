/**
 * In-app observe + page-script glue. Two things live here:
 *   1. BridgeObservePage — adapts the B1 bridge exec channel to the minimal
 *      Page subset the canonical observation/page-ops pipeline consumes.
 *   2. The A1 simple isolated-world action scripts (click/fill/select),
 *      kept out of in-app-backend.ts for the 400-LOC cap.
 *
 * BridgeObservePage adapts the bridge to the minimal
 * structural subset of Playwright's `Page` that the canonical observation /
 * page-ops pipeline consumes (observation.ts, extract.ts, stability.ts,
 * modal-detector.ts, iframe-detector.ts, page-ops.ts, and interactions.ts's
 * fingerprintPage). This is deliberately an ADAPTER, not a re-implementation:
 * ref/diff/format logic stays in ObservationRegistry, the extraction script
 * stays in extract.ts, output shaping stays in page-ops.ts — so both backends
 * share one source of truth for observation semantics and result shapes.
 *
 * Every script the adapter runs goes through browserExec, which executes in
 * the view's ISOLATED world only (world 1901, enforced desktop-side in
 * desktop/src/server-bridge-browser.ts) — page JS can never tamper with or
 * observe what the pipeline executes. No main-world channel exists here.
 */

import type { Page } from "playwright";
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

/**
 * The one deliberate cast in the in-app backend. ObservationRegistry.observe
 * and the page-ops helpers are typed against Playwright's `Page` but only
 * consume the structural subset BridgeObservePage implements (url / title /
 * evaluate / viewportSize / waitForLoadState / waitForFunction / $ /
 * innerText / screenshot / isClosed / bringToFront — see each callsite).
 * Widening the whole pipeline to a narrower PageLike interface is the right
 * long-term seam, but it touches observation/extract/stability/page-ops,
 * which are outside this chunk's scope lock; until then this adapter + cast
 * keeps ONE observation implementation instead of a forked one.
 */
export function asObservePage(adapter: BridgeObservePage): Page {
	return adapter as unknown as Page;
}
