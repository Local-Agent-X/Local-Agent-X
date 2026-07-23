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
import { browserCapture, browserExec } from "./bridge-client.js";
import { checkedScript } from "./in-app-scripts.js";
import { selectorQuery } from "./selector-compat.js";

/** Mutable url/title cache shared with the owning backend — updated on
 *  navigate results and lifecycle pings, read synchronously by url(). */
export interface BridgePageState {
	url: string;
	title: string;
	/** The view's REAL layout bounds, stamped from lifecycle pings
	 *  (in-app-tabs.stampPingState). Absent until the first ping. */
	viewport?: { width: number; height: number };
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

	/** The view's real bounds once a lifecycle ping has reported them; null
	 *  before the first ping → extract/modal detectors fall back to their
	 *  1280×800 default. Real bounds make inViewport labels (and the
	 *  obstruction detector's geometry) match the pane the user actually
	 *  sees instead of a hardcoded window size. */
	viewportSize(): { width: number; height: number } | null {
		return this.state.viewport ?? null;
	}

	async title(): Promise<string> {
		const t = await execChecked(this.viewId, "document.title");
		if (typeof t === "string") this.state.title = t;
		return this.state.title;
	}

	/** ISOLATED-world execution — the only world browserExec offers. Checked:
	 *  an in-page throw surfaces its real message, not Electron's generic one. */
	async evaluate(script: string): Promise<unknown> {
		return execChecked(this.viewId, script);
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
			if (await execChecked(this.viewId, expression)) return;
			if (Date.now() >= deadline) {
				throw new Error(`waitForFunction timed out after ${timeout}ms`);
			}
			await sleep(polling);
		}
	}

	/** page-ops.extractTextFrom seam: $(sel) → handle-with-innerText or null.
	 *  Resolves through the compat engine so Playwright-style selectors
	 *  (text=, :has-text()) work here the same as on the click/fill paths. */
	async $(selector: string): Promise<{ innerText(): Promise<string> } | null> {
		const exists = await execChecked(
			this.viewId,
			`(() => { const el = ${selectorQuery(selector)}; return !!el && !el.bad; })()`,
		);
		if (exists !== true) return null;
		return { innerText: () => this.innerText(selector) };
	}

	async innerText(selector: string): Promise<string> {
		const text = await execChecked(
			this.viewId,
			`(() => { const el = ${selectorQuery(selector)}; return el && !el.bad ? el.innerText : ""; })()`,
		);
		return typeof text === "string" ? text : "";
	}

	/** page-ops.screenshotAsBase64 seam — the view's current paint as PNG. */
	async screenshot(_opts?: { type?: string; fullPage?: boolean }): Promise<Buffer> {
		return Buffer.from(await browserCapture(this.viewId), "base64");
	}
}
/** browserExec with checkedScript: rethrows an in-page error WITH its message. */
export async function execChecked(viewId: string, script: string): Promise<unknown> {
	const raw = await browserExec(viewId, checkedScript(script));
	const err = raw && typeof raw === "object" ? (raw as { __laxScriptError?: unknown }).__laxScriptError : undefined;
	if (typeof err === "string") {
		throw new Error(`in-page script threw: ${err.slice(0, 500)}`);
	}
	return raw;
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
