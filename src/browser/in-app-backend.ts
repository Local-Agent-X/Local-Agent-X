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
 * Scope:
 *   - navigation, observe/snapshot/fingerprint, page reads, screenshot,
 *     evaluate (guarded), lifecycle — implemented.
 *   - tabs (chunk B): real multi-view tabs (in-app-tabs.ts) — new_tab opens
 *     an additional view; `tabs` also lists the user's own views and
 *     switch_tab onto one ADOPTS it (owned:false — driven, never closed).
 *   - click/fill/select (by SELECTOR): simple isolated-world DOM-eval versions.
 *   - clickByRef/fillByRef/clickByText/scroll (A2): the full resolution chain
 *     (role+name → visible text → XPath → coords, hit-tested) executed via real
 *     input events (browserInput synthetic-cursor path), in in-app-actions.ts.
 *   - screenshot: KB1 credential-focus guard blocks capture while a password
 *     field is focused in the co-driven view.
 *   - dialogs: JS dialogs need desktop-side interception — not-supported
 *     strings until then (A2/follow-up).
 *   - downloads: desktop quarantine records aren't plumbed to the server yet
 *     (follow-up chunk, P1/KB1 territory) — list is empty, approvals throw.
 */

import { ObservationRegistry, type BrowserObservation } from "./observation.js";
import { browserExec, browserNavigate } from "./bridge-client.js";
import {
	closeOwnedTabs,
	ensureTabView,
	formatTabsListing,
	refreshTabState,
	switchMergedTab,
	TabList,
	type InAppTab,
} from "./in-app-tabs.js";
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
	screenshotAsBase64,
} from "./page-ops.js";
import type { BridgePageState } from "./in-app-observe.js";
import {
	clickRefInApp,
	clickTextInApp,
	fillRefInApp,
	scrollInApp,
	CREDENTIAL_CAPTURE_BLOCKED,
	type InAppActionContext,
} from "./in-app-actions.js";
import {
	clickSelectorInApp,
	fillSelectorInApp,
	selectOptionInApp,
} from "./in-app-selector-actions.js";
import type { BrowserBackend, InteractionResult, ScrollOptions } from "./backend.js";
import type { BrowserEngine } from "./launcher.js";
import type { Page } from "playwright";
import { createInAppSecretOps, type SecretBrowserOps } from "./secret-ops.js";

/** The engine label surfaced in getInfo/screenshot output. */
const IN_APP_ENGINE = "electron";

/**
 * KB1 credential-focus probe (isolated world) — screenshot()'s sole gate.
 * Walks the focus chain through same-origin iframes AND open shadow roots
 * (activeElement retargets to the shadow host). Fails CLOSED: a focused
 * CROSS-ORIGIN iframe (contentDocument null/throws) is unreadable but
 * focus-is-inside-it IS observable — the canonical embedded bank/Stripe/Plaid/
 * OAuth login — so we block (over-blocking any cross-origin embed is the right
 * direction; CREDENTIAL_CAPTURE_BLOCKED names that reason). Closed shadow roots
 * are the residual gap.
 */
export const CREDENTIAL_FOCUS_SCRIPT = `(() => {
	let el = document.activeElement;
	for (let i = 0; i < 16 && el; i++) {
		if (el.tagName === "IFRAME") {
			let doc = null;
			try { doc = el.contentDocument; } catch { return true; }
			if (!doc) return true;
			el = doc.activeElement;
			continue;
		}
		if (el.shadowRoot && el.shadowRoot.activeElement) {
			el = el.shadowRoot.activeElement;
			continue;
		}
		break;
	}
	if (!el || el.tagName !== "INPUT" || !el.getAttribute) return false;
	const type = (el.getAttribute("type") || "").toLowerCase();
	const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
	return type === "password" || ac === "current-password" || ac === "new-password";
})()`;

// ── Typed errors ─────────

/** Same message shape the CDP path produces, thrown BEFORE any bridge call —
 *  a blocked script never reaches the view. */
export class EvaluateBlockedError extends Error {
	constructor(pattern: string) {
		super(
			`Blocked: script contains restricted pattern (${pattern}). ` +
				`evaluate() is for DOM inspection only — use http_request for API calls.`,
		);
		this.name = "EvaluateBlockedError";
	}
}

/** Desktop download quarantine isn't plumbed to the server yet; approval/release must fail closed (follow-up). */
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
	/** All per-view state lives in the tabs; the first tab keeps the legacy
	 *  `view-<sessionId>-<profileId>` id so prior sessions' views get adopted
	 *  by ensureView's "already exists" path. */
	private readonly tabs: TabList;

	constructor(
		private readonly sessionId: string,
		private readonly profileId: string,
		viewId: string,
	) {
		this.tabs = new TabList(viewId);
	}

	// ── Active-tab accessors (every action routes through the active tab) ──

	private get activeTab(): InAppTab {
		return this.tabs.active;
	}

	private get state(): BridgePageState {
		return this.activeTab.state;
	}

	private get registry(): ObservationRegistry {
		return this.activeTab.registry;
	}

	private get page(): Page {
		return this.activeTab.page;
	}

	private get viewId(): string {
		return this.activeTab.viewId;
	}

	// ── Identity / state ──

	getProfileId(): string {
		return this.profileId;
	}

	getCurrentUrl(): string {
		return this.state.url;
	}

	isActive(): boolean {
		return this.activeTab.created && !this.activeTab.closed;
	}

	// ── View lifecycle plumbing (per-tab implementations in in-app-tabs.ts) ──

	private ensureView(tab: InAppTab = this.activeTab): Promise<void> {
		return ensureTabView(tab, this.profileId);
	}

	private refreshState(tab: InAppTab = this.activeTab): Promise<void> {
		return refreshTabState(tab);
	}

	// ── Navigation / observation ──

	async navigate(url: string, _engine?: BrowserEngine): Promise<string> {
		url = injectTokenIfLocal(url);
		const requestedHost = safeHost(url);
		await this.ensureView();
		// The bridge navigate settles on load events and carries no HTTP status,
		// so an HTTP ≥400 page isn't detectable here yet — "Status: unknown" is
		// the in-family CDP value for a missing response (desktop follow-up).
		const result = await browserNavigate(this.viewId, url);
		this.state.url = result.url;
		this.state.title = result.title;
		const sensitive = sensitivePageStub(result.url);
		if (sensitive) return sensitive;
		const redirect = redirectMessage(requestedHost, safeHost(result.url));
		return `Navigated to: ${result.url}\nStatus: unknown\nTitle: ${result.title}${redirect}`;
	}

	/** Open a REAL additional view (viewId `<first>-t<N>`, N monotonic) and make
	 *  it the active tab. Same output shape as CDP newTab. When the backend has
	 *  no live view yet, this just materializes the first tab — there is no
	 *  "current tab" to keep open. */
	async newTab(url: string): Promise<string> {
		url = injectTokenIfLocal(url);
		const requestedHost = safeHost(url);
		const minted = this.isActive();
		const tab = minted ? this.tabs.openOwned() : this.activeTab;
		try {
			await this.ensureView(tab);
		} catch (e) {
			if (minted) this.tabs.remove(tab); // roll back the tab that never materialized
			throw e;
		}
		const result = await browserNavigate(tab.viewId, url);
		tab.state.url = result.url;
		tab.state.title = result.title;
		const sensitive = sensitivePageStub(result.url);
		if (sensitive) return sensitive;
		const redirect = redirectMessage(requestedHost, safeHost(result.url));
		return `Opened new tab (${this.tabs.all().length} tabs total)\nURL: ${result.url}\nStatus: unknown\nTitle: ${result.title}${redirect}`;
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

	// ── Interaction (A1 drivers live in in-app-actions.ts beside the A2 chain) ──

	async click(selector: string): Promise<string> {
		await this.ensureView();
		await clickSelectorInApp(this.viewId, selector);
		const snap = await this.snapshot(); // refreshes state.url too
		return `Clicked: ${selector}\nPage: ${this.state.url}\n\n${snap}`;
	}

	async fill(selector: string, value: string): Promise<string> {
		await this.ensureView();
		return fillSelectorInApp(this.viewId, selector, value);
	}

	async select(selector: string, value: string): Promise<string> {
		await this.ensureView();
		return selectOptionInApp(this.viewId, selector, value);
	}

	/** Page access for the secret tools. Lives off the tool-facing contract on
	 *  purpose — a secret must never take the formatted, value-echoing paths in
	 *  BrowserBackend (see secret-ops.ts). */
	secretOps(): SecretBrowserOps {
		// viewId resolves at CALL time — a switch_tab between secret ops must
		// retarget the ops to the newly active tab.
		return createInAppSecretOps({ viewId: () => this.viewId, ensureView: () => this.ensureView() });
	}

	/** The A2 resolution-chain + real-input driver context. Shares this
	 *  backend's registry/page/viewId so refs resolve against the same
	 *  observation state the snapshot minted. */
	private actionContext(): InAppActionContext {
		return { viewId: this.viewId, page: this.page, registry: this.registry };
	}

	async clickByRef(ref: number): Promise<InteractionResult> {
		await this.ensureView();
		return clickRefInApp(this.actionContext(), ref);
	}

	async fillByRef(ref: number, value: string): Promise<InteractionResult> {
		await this.ensureView();
		return fillRefInApp(this.actionContext(), ref, value);
	}

	async clickByText(text: string): Promise<InteractionResult> {
		await this.ensureView();
		return clickTextInApp(this.actionContext(), text);
	}

	async scroll(opts: ScrollOptions): Promise<string> {
		await this.ensureView();
		return scrollInApp(this.actionContext(), opts);
	}

	// ── Page reads / tabs ──

	async extractText(selector?: string, find?: string): Promise<string> {
		await this.ensureView();
		return extractTextFrom(this.page, selector, find);
	}

	async screenshot(): Promise<string> {
		await this.ensureView();
		// KB1 (plan invariant S1-5): never paint pixels while a credential field
		// is focused in the co-driven view — the user may be mid-password. Probe
		// the isolated world FIRST; if blocked, do NOT reach browserCapture.
		const credentialFocused = await browserExec(this.viewId, CREDENTIAL_FOCUS_SCRIPT);
		if (credentialFocused === true) return CREDENTIAL_CAPTURE_BLOCKED;
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

	/** This backend's tabs plus the user's own (non-agent-driven) views, which
	 *  are marked as takeover candidates. Indexes are as-of this listing —
	 *  switchTab recomputes the same merge. */
	async listTabs(): Promise<string> {
		if (!this.isActive()) return listTabsOp([], null);
		return formatTabsListing(this.tabs, (tab) => this.refreshState(tab));
	}

	/** Switch over the same combined ordering listTabs prints. A user view is
	 *  ADOPTED (owned:false — driven, never closed) and becomes active. */
	async switchTab(index: number): Promise<string> {
		if (!this.isActive()) return listTabsOp([], null); // "No browser session active."
		const result = await switchMergedTab(this.tabs, index);
		if (!result.ok) return result.message;
		await this.refreshState(result.tab);
		const sensitive = sensitivePageStub(this.state.url);
		return sensitive ?? `Switched to tab [${index}]: ${this.state.title} — ${this.state.url}`;
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

	/** Closes owned views only; adopted user tabs are dropped, never closed. */
	async close(): Promise<void> {
		await closeOwnedTabs(this.tabs);
	}
}
