/**
 * ElectronInAppBackend — BrowserBackend #2: drives an embedded desktop
 * WebContentsView (desktop/src/browser-views.ts) through the B1 bridge
 * (bridge-client.ts) instead of external Chrome over CDP/Playwright.
 *
 * Canonical layering is preserved: observation refs/diffs/formatting stay in
 * ObservationRegistry, in-page extraction stays in extract.ts, output shaping
 * stays in page-ops.ts — all reached through the BridgeObservePage adapter
 * (in-app-observe.ts), so both backends share one observation pipeline and
 * the tool layer sees identical result shapes.
 *
 * A1 scope:
 *   - navigation, observe/snapshot/fingerprint, page reads, screenshot,
 *     evaluate (guarded), tabs (single-view), lifecycle — implemented.
 *   - click/fill/select: SIMPLE isolated-world DOM-eval versions. Chunk A2
 *     replaces them with the full resolution chain + real input events
 *     (browserInput synthetic cursor path).
 *   - clickByRef/fillByRef/clickByText/scroll: throw NotImplementedError
 *     until A2 delivers the resolution chain.
 *   - dialogs: JS dialogs need desktop-side interception — not-supported
 *     strings until then (A2/follow-up).
 *   - downloads: desktop quarantine records aren't plumbed to the server yet
 *     (follow-up chunk, P1/KB1 territory) — list is empty, approvals throw.
 */

import { ObservationRegistry, type BrowserObservation } from "./observation.js";
import { browserExec, browserLifecycle, browserNavigate } from "./bridge-client.js";
import { profilePartition } from "./profile-store.js";
import { injectTokenIfLocal } from "./auth-context.js";
import { redirectMessage, safeHost } from "./redirect.js";
import { scanEvaluateScript, sensitivePageStub } from "./guards.js";
import { formatRecentDownloads, type DownloadApprovalBinding } from "./downloads.js";
import { fingerprintPage } from "./interactions.js";
import {
	evaluateScript,
	extractTextFrom,
	listTabs as listTabsOp,
	pageInfo,
	resolveSwitchTab,
	screenshotAsBase64,
} from "./page-ops.js";
import {
	asExecResult,
	asObservePage,
	BridgeObservePage,
	clickScript,
	fillScript,
	selectScript,
	type BridgePageState,
} from "./in-app-observe.js";
import type { BrowserBackend, InteractionResult, ScrollOptions } from "./backend.js";
import type { BrowserEngine } from "./launcher.js";
import type { Page } from "playwright";
import { createLogger } from "../logger.js";

const logger = createLogger("browser.in-app");

/** The engine label surfaced in getInfo/screenshot output. */
const IN_APP_ENGINE = "electron";

// ── Typed errors ─────────

/** A1 placeholder: the ref/text resolution chain + real input events land in
 *  chunk A2. Message names the workaround so the agent isn't dead-ended. */
export class NotImplementedError extends Error {
	constructor(method: string) {
		super(
			`browser ${method} is not implemented by the in-app backend yet — ` +
				`the ref/text resolution chain and real input events land in chunk A2. ` +
				`Use selector-based click/fill/select, evaluate, or extract in the meantime.`,
		);
		this.name = "NotImplementedError";
	}
}

/** Same message shape the tool layer produces for the CDP path, so a blocked
 *  script reads identically regardless of backend. Thrown BEFORE any bridge
 *  call — a blocked script never reaches the view. */
export class EvaluateBlockedError extends Error {
	constructor(pattern: string) {
		super(
			`Blocked: script contains restricted pattern (${pattern}). ` +
				`evaluate() is for DOM inspection only — use http_request for API calls.`,
		);
		this.name = "EvaluateBlockedError";
	}
}

/** Desktop download quarantine records aren't plumbed to the server yet
 *  (follow-up chunk). Approval/release must fail closed, not fake-succeed. */
export class InAppDownloadsUnavailableError extends Error {
	constructor(op: string) {
		super(
			`browser ${op} is not available in the in-app backend yet — desktop ` +
				`download quarantine is not plumbed to the server (follow-up chunk).`,
		);
		this.name = "InAppDownloadsUnavailableError";
	}
}

// ── Backend ─────────

export class ElectronInAppBackend implements BrowserBackend {
	private created = false;
	private closed = false;
	private readonly state: BridgePageState = { url: "", title: "" };
	private readonly registry = new ObservationRegistry();
	private readonly page: Page;

	constructor(
		private readonly sessionId: string,
		private readonly profileId: string,
		private readonly viewId: string,
	) {
		this.page = asObservePage(new BridgeObservePage(viewId, this.state, () => this.closed));
	}

	// ── Identity / state ──

	getProfileId(): string {
		return this.profileId;
	}

	getCurrentUrl(): string {
		return this.state.url;
	}

	isActive(): boolean {
		return this.created && !this.closed;
	}

	// ── View lifecycle plumbing ──

	/** Lazily create the view on the profile's partition. Adopts a view that
	 *  already exists (a prior backend instance for the same (session, profile)
	 *  created it) instead of failing. */
	private async ensureView(): Promise<void> {
		if (this.created && !this.closed) return;
		try {
			await browserLifecycle("create", this.viewId, {
				partition: profilePartition(this.profileId),
			});
		} catch (e) {
			if (!(e instanceof Error) || !e.message.includes("already exists")) throw e;
		}
		this.created = true;
		this.closed = false;
	}

	/** Refresh cached url/title from the live view. Advisory: a failed ping
	 *  keeps the last-known values rather than wedging the caller. */
	private async refreshState(): Promise<void> {
		try {
			const { ping } = await browserLifecycle("ping", this.viewId);
			if (ping?.ok) {
				if (typeof ping.url === "string") this.state.url = ping.url;
				if (typeof ping.title === "string") this.state.title = ping.title;
			}
		} catch (e) {
			logger.warn(`[in-app] ping failed (viewId=${this.viewId}): ${(e as Error).message}`);
		}
	}

	// ── Navigation / observation ──

	async navigate(url: string, _engine?: BrowserEngine): Promise<string> {
		url = injectTokenIfLocal(url);
		const requestedHost = safeHost(url);
		await this.ensureView();
		// NOTE: the bridge navigate settles on load events and carries no HTTP
		// status, so unlike the CDP path an HTTP ≥400 page is not detectable
		// here yet — "Status: unknown" is the in-family CDP value for a missing
		// response. Surfacing the status via the desktop is a follow-up.
		const result = await browserNavigate(this.viewId, url);
		this.state.url = result.url;
		this.state.title = result.title;
		const sensitive = sensitivePageStub(result.url);
		if (sensitive) return sensitive;
		const redirect = redirectMessage(requestedHost, safeHost(result.url));
		return `Navigated to: ${result.url}\nStatus: unknown\nTitle: ${result.title}${redirect}`;
	}

	/** Single-document view: newTab navigates the same view (parallelism comes
	 *  from per-(session, profile) views, not tabs). Same shape as CDP newTab. */
	async newTab(url: string): Promise<string> {
		url = injectTokenIfLocal(url);
		const requestedHost = safeHost(url);
		await this.ensureView();
		const result = await browserNavigate(this.viewId, url);
		this.state.url = result.url;
		this.state.title = result.title;
		const sensitive = sensitivePageStub(result.url);
		if (sensitive) return sensitive;
		const redirect = redirectMessage(requestedHost, safeHost(result.url));
		return `Opened new tab (1 tabs total)\nURL: ${result.url}\nStatus: unknown\nTitle: ${result.title}${redirect}`;
	}

	async observe(): Promise<BrowserObservation> {
		await this.ensureView();
		await this.refreshState();
		return this.registry.observe(this.page);
	}

	async snapshot(): Promise<string> {
		return ObservationRegistry.format(await this.observe());
	}

	async fingerprint(): Promise<string> {
		try {
			await this.ensureView();
			return await fingerprintPage(this.page);
		} catch {
			return "";
		}
	}

	// ── Interaction (A1: simple isolated-world eval; A2 replaces) ──

	async click(selector: string): Promise<string> {
		await this.ensureView();
		const res = asExecResult(await browserExec(this.viewId, clickScript(selector)));
		if (!res.ok) {
			if (res.error === "not-found") throw new Error(`Element not found: ${selector}`);
			throw new Error(`Cannot click ${selector}: ${res.error}`);
		}
		const snap = await this.snapshot(); // refreshes state.url too
		return `Clicked: ${selector}\nPage: ${this.state.url}\n\n${snap}`;
	}

	async fill(selector: string, value: string): Promise<string> {
		await this.ensureView();
		const res = asExecResult(await browserExec(this.viewId, fillScript(selector, value)));
		if (!res.ok) {
			if (res.error === "not-found") throw new Error(`Element not found: ${selector}`);
			throw new Error(`Cannot fill ${selector}: ${res.error}`);
		}
		const actual = typeof res.actual === "string" ? res.actual : "";
		if (actual === value) return `Filled "${selector}" with value (${value.length} chars)`;
		if (actual === "" && res.type === "password") {
			return `Filled "${selector}" (verification skipped: masked input)`;
		}
		throw new Error(`Fill did not land: expected '${value}' got '${actual}'`);
	}

	async select(selector: string, value: string): Promise<string> {
		await this.ensureView();
		const res = asExecResult(await browserExec(this.viewId, selectScript(selector, value)));
		if (!res.ok) {
			if (res.error === "not-found") throw new Error(`Element not found: ${selector}`);
			throw new Error(`Cannot select in ${selector}: ${res.error}`);
		}
		const selected = Array.isArray(res.selected) ? res.selected.map(String) : [];
		return `Selected "${selected.join(", ")}" in ${selector}`;
	}

	async clickByRef(_ref: number): Promise<InteractionResult> {
		throw new NotImplementedError("click (by ref)");
	}

	async fillByRef(_ref: number, _value: string): Promise<InteractionResult> {
		throw new NotImplementedError("fill (by ref)");
	}

	async clickByText(_text: string): Promise<InteractionResult> {
		throw new NotImplementedError("click_text");
	}

	async scroll(_opts: ScrollOptions): Promise<string> {
		throw new NotImplementedError("scroll");
	}

	// ── Page reads / tabs ──

	async extractText(selector?: string, find?: string): Promise<string> {
		await this.ensureView();
		return extractTextFrom(this.page, selector, find);
	}

	async screenshot(): Promise<string> {
		await this.ensureView();
		return screenshotAsBase64(this.page, IN_APP_ENGINE);
	}

	async evaluate(script: string): Promise<string> {
		// Guarded here as well as at the tool layer (defense in depth): a
		// blocked script must never reach the bridge from ANY caller.
		const blockedPattern = scanEvaluateScript(script);
		if (blockedPattern) throw new EvaluateBlockedError(blockedPattern);
		await this.ensureView();
		return evaluateScript(this.page, script);
	}

	async getInfo(): Promise<string> {
		if (!this.isActive()) return pageInfo(null, IN_APP_ENGINE);
		await this.refreshState();
		return pageInfo(this.page, IN_APP_ENGINE);
	}

	async listTabs(): Promise<string> {
		if (!this.isActive()) return listTabsOp([], null);
		return listTabsOp([this.page], this.page);
	}

	async switchTab(index: number): Promise<string> {
		const pages = this.isActive() ? [this.page] : [];
		const result = await resolveSwitchTab(pages, index);
		return result.message;
	}

	// ── Dialogs (need desktop-side interception — A2/follow-up) ──

	async dialogAccept(_promptText?: string): Promise<string> {
		return (
			"Dialog handling is not supported by the in-app browser backend yet — " +
			"JS dialogs require desktop-side interception (chunk A2 follow-up). No dialog was accepted."
		);
	}

	async dialogDismiss(): Promise<string> {
		return (
			"Dialog handling is not supported by the in-app browser backend yet — " +
			"JS dialogs require desktop-side interception (chunk A2 follow-up). No dialog was dismissed."
		);
	}

	// ── Downloads (desktop quarantine not plumbed to server yet) ──

	getDownloads(): string {
		// Canonical formatter; desktop-side downloads aren't recorded into the
		// server's session records yet, so this reports the empty state.
		return formatRecentDownloads(this.sessionId);
	}

	getDownloadApproval(_id: string): DownloadApprovalBinding {
		throw new InAppDownloadsUnavailableError("download approval");
	}

	async releaseDownload(_id: string, _approved: DownloadApprovalBinding): Promise<string> {
		throw new InAppDownloadsUnavailableError("download release");
	}

	// ── Lifecycle ──

	async close(): Promise<void> {
		this.registry.reset();
		this.state.url = "";
		this.state.title = "";
		if (!this.created || this.closed) return;
		this.closed = true;
		this.created = false;
		try {
			await browserLifecycle("close", this.viewId);
		} catch (e) {
			// The view may already be gone (desktop teardown) — closing twice
			// must not fail the caller's cleanup path.
			logger.warn(`[in-app] close failed (viewId=${this.viewId}): ${(e as Error).message}`);
		}
	}
}
