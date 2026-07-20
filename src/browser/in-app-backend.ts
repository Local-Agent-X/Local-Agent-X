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
 *   - navigation (real HTTP status when the desktop observed one), observe/
 *     snapshot/fingerprint, page reads, screenshot, evaluate (guarded),
 *     lifecycle — implemented.
 *   - tabs (chunk B): real multi-view tabs (in-app-tabs.ts); `tabs` also lists
 *     the user's own views and switch_tab ADOPTS one (driven, never closed).
 *   - click/fill/select (by SELECTOR): simple isolated-world DOM-eval versions.
 *   - clickByRef/fillByRef/clickByText/scroll (A2): resolution chain over real
 *     input events (browserInput synthetic-cursor path), in in-app-actions.ts.
 *   - readConsole/readNetwork (chunk E): desktop perception rings, active tab.
 *   - screenshot: KB1 credential-focus guard blocks capture while a password
 *     field is focused in the co-driven view. The gate + the perception and
 *     dialog passthroughs live in in-app-page-io.ts (LOC cap).
 *   - dialogs (chunk F): beforeunload interception via the desktop queue
 *     (browser-dialogs.ts); alert/confirm/prompt have no Electron hook.
 *   - downloads (chunk F): the desktop pushes finished quarantine entries
 *     into the canonical downloads.ts records; list/approve/release delegate.
 */

import { ObservationRegistry, type BrowserObservation } from "./observation.js";
import { browserLifecycle, browserNavigate } from "./bridge-client.js";
import { enrichBlockedNavigation } from "./bridge-egress.js";
import {
	acceptDialogInApp,
	captureScreenshotInApp,
	dismissDialogInApp,
	IN_APP_ENGINE,
	IN_APP_NO_DIALOG,
	readConsoleInApp,
	readNetworkInApp,
} from "./in-app-page-io.js";
import {
	closeOwnedTabs,
	ensureTabView,
	formatTabsListing,
	navigationReport,
	refreshTabState,
	switchMergedTab,
	TabList,
	type InAppTab,
} from "./in-app-tabs.js";
import { injectTokenIfLocal } from "./auth-context.js";
import { safeHost } from "./redirect.js";
import { scanEvaluateScript, sensitivePageStub } from "./guards.js";
import { formatRecentDownloads, getDownloadApprovalBinding, releaseQuarantinedDownload, type DownloadApprovalBinding } from "./downloads.js";
import { fingerprintPage } from "./interactions.js";
import {
	evaluateScript,
	extractTextFrom,
	listTabs as listTabsOp,
	pageInfo,
} from "./page-ops.js";
import type { BridgePageState } from "./in-app-observe.js";
import {
	clickRefInApp,
	clickTextInApp,
	fillRefInApp,
	scrollInApp,
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
import { createLogger } from "../logger.js";

const logger = createLogger("browser.in-app-backend");

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
		let result;
		try {
			result = await browserNavigate(this.viewId, url);
		} catch (e) {
			throw enrichBlockedNavigation(e, url);
		}
		this.state.url = result.url;
		this.state.title = result.title;
		return navigationReport("Navigated to: ", result, requestedHost);
	}

	/** Open a REAL additional view (viewId `<first>-t<N>`, N monotonic) and make
	 *  it the active tab. Same output shape as CDP newTab. When the backend has
	 *  no live view yet, this just materializes the first tab — there is no
	 *  "current tab" to keep open. */
	async newTab(url: string): Promise<string> {
		url = injectTokenIfLocal(url);
		const requestedHost = safeHost(url);
		const minted = this.isActive();
		const prevActive = this.activeTab; // rollback target — openOwned moves the active pointer
		const tab = minted ? this.tabs.openOwned() : this.activeTab;
		try {
			await this.ensureView(tab);
		} catch (e) {
			if (minted) this.rollbackMintedTab(tab, prevActive); // roll back the tab that never materialized
			throw e;
		}
		let result;
		try {
			result = await browserNavigate(tab.viewId, url);
		} catch (e) {
			// The view materialized but the navigation itself failed (bridge
			// timeout, DNS): without rollback a ghost blank tab would stay in
			// the list AND remain active. Close the created view (tolerating an
			// already-gone view, like closeOwnedTabs), drop the tab, restore
			// the previous active pointer, and rethrow — callers (including
			// multi-URL new_tab's per-URL loop) rely on the throw.
			// minted === false is the first-tab materialization: today's
			// behavior stands — the first tab is never rolled back.
			if (minted) {
				tab.closed = true;
				tab.created = false;
				try {
					await browserLifecycle("close", tab.viewId);
				} catch (closeErr) {
					logger.warn(`[in-app] rollback close failed (viewId=${tab.viewId}): ${(closeErr as Error).message}`);
				}
				this.rollbackMintedTab(tab, prevActive);
			}
			throw enrichBlockedNavigation(e, url);
		}
		tab.state.url = result.url;
		tab.state.title = result.title;
		return navigationReport(`Opened new tab (${this.tabs.all().length} tabs total)\nURL: `, result, requestedHost);
	}

	/** Drop a tab minted by openOwned for a new_tab that failed, and put the
	 *  active pointer back on the tab that was active before the call.
	 *  TabList.remove only CLAMPS activeIdx (it would land on the new last
	 *  tab, not necessarily the previous active), so the restore is explicit.
	 *  Minted tabs are never index 0 — openOwned pushes onto a non-empty
	 *  list — so remove's never-remove-the-first-tab guard cannot fire here. */
	private rollbackMintedTab(tab: InAppTab, prevActive: InAppTab): void {
		this.tabs.remove(tab);
		this.tabs.setActive(prevActive);
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

	/** Page access for the secret tools — off the tool-facing contract on purpose:
	 *  a secret never takes the value-echoing BrowserBackend paths (secret-ops.ts). */
	secretOps(): SecretBrowserOps {
		// viewId resolves at CALL time — switch_tab between ops must retarget.
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
		// KB1 credential-focus gate + capture live in in-app-page-io.ts.
		return captureScreenshotInApp(this.viewId, this.page);
	}

	async evaluate(script: string): Promise<string> {
		// Guarded here AND at the tool layer (defense in depth): a blocked
		// script must never reach the bridge from any caller.
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
		const result = await switchMergedTab(this.tabs, index, this.sessionId);
		if (!result.ok) return result.message;
		await this.refreshState(result.tab);
		const sensitive = sensitivePageStub(this.state.url);
		return sensitive ?? `Switched to tab [${index}]: ${this.state.title} — ${this.state.url}`;
	}

	// ── Perception (desktop console/network rings, active tab) ──

	async readConsole(): Promise<string> {
		await this.ensureView();
		return readConsoleInApp(this.viewId);
	}
	async readNetwork(): Promise<string> {
		await this.ensureView();
		return readNetworkInApp(this.viewId);
	}

	// ── Dialogs (beforeunload queue on the desktop — browser-dialogs.ts) ──
	// No ensureView: a dialog can only pend on an EXISTING view — never mint
	// one. promptText is parity only; prompt() isn't interceptable here.

	async dialogAccept(_promptText?: string): Promise<string> {
		if (!this.isActive()) return IN_APP_NO_DIALOG;
		return acceptDialogInApp(this.viewId);
	}

	async dialogDismiss(): Promise<string> {
		if (!this.isActive()) return IN_APP_NO_DIALOG;
		return dismissDialogInApp(this.viewId);
	}

	// ── Downloads — same delegations to downloads.ts the CDP manager makes:
	// one policy, one digest-bound approval/release law for both backends.

	getDownloads(): string {
		return formatRecentDownloads(this.sessionId);
	}

	getDownloadApproval(id: string): DownloadApprovalBinding {
		return getDownloadApprovalBinding(this.sessionId, id);
	}

	async releaseDownload(id: string, approved: DownloadApprovalBinding): Promise<string> {
		const record = await releaseQuarantinedDownload(this.sessionId, id, approved);
		return `RELEASED: ${record.filename} (${record.size} bytes)\nReleased to: ${record.releasePath}`;
	}

	// ── Lifecycle ──

	/** Closes owned views only; adopted user tabs are dropped, never closed. */
	async close(): Promise<void> {
		await closeOwnedTabs(this.tabs, this.sessionId);
	}
}
