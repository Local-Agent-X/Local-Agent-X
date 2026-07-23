/**
 * In-app tab model (chunk B) — the multi-view bookkeeping behind
 * ElectronInAppBackend. Every desktop bridge op is viewId-keyed, so "tabs"
 * are pure server-side records: one WebContentsView per tab, each with its
 * own url/title cache, ObservationRegistry, and observe-page adapter (the
 * same canonical observation pipeline both backends share).
 *
 * Ownership: tabs the agent opened (the first view + new_tab views) are
 * owned:true and are closed on backend close(). Tabs ADOPTED from the user's
 * own browser (switch_tab onto a "[user tab]" row) are owned:false — the
 * agent drives them but never closes them; close() just drops them.
 *
 * The COMBINED ordering (own tabs + user views) that `tabs` prints — merge,
 * listing format, switch/adopt, close_tab — lives in in-app-tab-merge.ts
 * (split for the 400-LOC ceiling).
 */

import type { Page } from "playwright";
import { ObservationRegistry } from "./observation.js";
import { asObservePage, BridgeObservePage, type BridgePageState } from "./in-app-observe.js";
import { browserAbort, browserLifecycle, browserNavigate, type BrowserNavigateResult, type BrowserViewInfo } from "./bridge-client.js";
import { profilePartition } from "./profile-store.js";
import { redirectMessage, safeHost } from "./redirect.js";
import { sensitivePageStub } from "./guards.js";
import { unregisterAdoptedViews } from "./bridge-perception.js";
import { createLogger } from "../logger.js";

const logger = createLogger("browser.in-app-tabs");

/** One WebContentsView the backend drives, with its per-tab observation state. */
export class InAppTab {
	created: boolean;
	closed = false;
	/** URL to reload when the view is recreated after dying out from under the
	 *  agent (wedge teardown, user ✕). Survives resetToFirst; cleared by
	 *  navigate/new_tab (which supply their own URL) and by the reload itself. */
	lastUrl = "";
	readonly state: BridgePageState = { url: "", title: "" };
	readonly registry = new ObservationRegistry();
	readonly page: Page;

	constructor(
		readonly viewId: string,
		/** true = this backend created the view and closes it; false = adopted user view. */
		readonly owned: boolean,
		created = false,
	) {
		this.created = created;
		this.page = asObservePage(new BridgeObservePage(viewId, this.state, () => this.closed));
	}
}

/** The backend's tabs plus the active pointer. Invariant: tabs[0] is always
 *  the first (legacy-viewId) tab — it survives close() so a re-used backend
 *  keeps adopting the same desktop view. */
export class TabList {
	private readonly tabs: InAppTab[];
	private activeIdx = 0;
	/** Monotonic new_tab counter — an N is never reused within a backend's lifetime. */
	private nextTabNumber = 2;

	constructor(private readonly firstViewId: string) {
		this.tabs = [new InAppTab(firstViewId, true)];
	}

	get active(): InAppTab {
		return this.tabs[this.activeIdx];
	}

	all(): readonly InAppTab[] {
		return this.tabs;
	}

	has(viewId: string): boolean {
		return this.tabs.some((t) => t.viewId === viewId);
	}

	setActive(tab: InAppTab): void {
		const idx = this.tabs.indexOf(tab);
		if (idx < 0) throw new Error(`tab "${tab.viewId}" is not in this backend's tab list`);
		this.activeIdx = idx;
	}

	/** Mint the next agent-owned tab (viewId `<first>-t<N>`) and make it active. */
	openOwned(): InAppTab {
		const tab = new InAppTab(`${this.firstViewId}-t${this.nextTabNumber++}`, true);
		this.tabs.push(tab);
		this.activeIdx = this.tabs.length - 1;
		return tab;
	}

	/** Take over a user view: track it owned:false (created — the desktop owns
	 *  its lifecycle) and make it active. */
	adopt(view: BrowserViewInfo): InAppTab {
		const tab = new InAppTab(view.viewId, false, true);
		tab.state.url = view.url;
		tab.state.title = view.title;
		this.tabs.push(tab);
		this.activeIdx = this.tabs.length - 1;
		return tab;
	}

	/** Roll back a tab that failed to materialize (new_tab create error). */
	remove(tab: InAppTab): void {
		const idx = this.tabs.indexOf(tab);
		if (idx <= 0) return; // never remove the first tab
		this.tabs.splice(idx, 1);
		if (this.activeIdx >= this.tabs.length) this.activeIdx = this.tabs.length - 1;
		else if (this.activeIdx > idx) this.activeIdx--;
	}

	/** Drop a minted tab that failed to materialize and restore the active
	 *  pointer to the tab active BEFORE the call — remove() only CLAMPS
	 *  activeIdx, which would land on the new last tab instead. Minted tabs are
	 *  never index 0, so remove's first-tab guard cannot fire here. */
	rollbackMinted(tab: InAppTab, prevActive: InAppTab): void {
		this.remove(tab);
		this.setActive(prevActive);
	}

	/** close() bookkeeping: reset every tab's observation state, then drop all
	 *  but the first tab. The new_tab counter is NOT reset — Ns never recur.
	 *  lastUrl is RETAINED (per tab): a backend that survives this reset (wedge
	 *  teardown) reloads the page on the next ensureTabView. */
	resetToFirst(): void {
		for (const tab of this.tabs) {
			tab.registry.reset();
			tab.lastUrl = tab.state.url || tab.lastUrl;
			tab.state.url = "";
			tab.state.title = "";
			tab.closed = true;
			tab.created = false;
		}
		this.tabs.length = 1;
		this.activeIdx = 0;
		this.lastListing = null;
	}

	/** viewIds in the order the last `tabs` listing printed them — the pin
	 *  switchMergedTab verifies against, so a pool that changed between the
	 *  listing and the switch can never cause adoption of the WRONG user tab. */
	lastListing: string[] | null = null;
}

// ── Per-tab view lifecycle (bridge ops keyed on the tab's viewId) ─────────

/** Lazily create a tab's view on the profile's partition. Adopts a view that
 *  already exists (a prior backend instance for the same (session, profile)
 *  created it) instead of failing. */
export async function ensureTabView(tab: InAppTab, profileId: string): Promise<void> {
	if (tab.created && !tab.closed) return;
	try {
		await browserLifecycle("create", tab.viewId, {
			partition: profilePartition(profileId),
		});
	} catch (e) {
		if (!(e instanceof Error) || !e.message.includes("already exists")) throw e;
	}
	tab.created = true;
	tab.closed = false;
	// A recreated view (wedge teardown, user ✕) lands on about:blank — put it
	// back on the page the tab was on so the agent's next action still has its
	// page. Advisory: a failed reload leaves the blank view rather than failing
	// the caller's action; navigate()/newTab() clear lastUrl before ensureView,
	// so they never pay for a reload they are about to replace.
	const lastUrl = tab.lastUrl;
	tab.lastUrl = "";
	if (lastUrl) {
		try {
			const result = await browserNavigate(tab.viewId, lastUrl);
			tab.state.url = result.url;
			tab.state.title = result.title;
		} catch (e) {
			logger.warn(`[in-app] recovery reload failed (viewId=${tab.viewId}, url=${lastUrl}): ${(e as Error).message}`);
		}
	}
}

/** Soft wedge probe (instance.ts resetWedgedBrowser): abort the tab's
 *  in-flight load, then ping its view. A live view answers within
 *  LIFECYCLE_TIMEOUT_MS: refresh the cached url/title and reset the tab's
 *  observation state — the wedged scan was abandoned, and its late completion
 *  is discarded by the registry's epoch guard. A dead, never-created, or
 *  unpingable view reports false and the caller falls back to teardown. */
export async function probeTabAfterWedge(tab: InAppTab): Promise<boolean> {
	if (!tab.created || tab.closed) return false;
	browserAbort(tab.viewId);
	try {
		const { ping } = await browserLifecycle("ping", tab.viewId);
		if (!ping?.ok) return false;
		if (typeof ping.url === "string") tab.state.url = ping.url;
		if (typeof ping.title === "string") tab.state.title = ping.title;
	} catch (e) {
		logger.warn(`[in-app] wedge probe failed (viewId=${tab.viewId}): ${(e as Error).message}`);
		return false;
	}
	tab.registry.reset();
	return true;
}

/** Hard wedge teardown: same bookkeeping as closeOwnedTabs but SYNCHRONOUS —
 *  the bridge closes are fire-and-forget because the bridge may itself be the
 *  thing that is wedged, and the caller must not hang on it. The active tab's
 *  URL survives on the first tab as lastUrl so the next ensureTabView
 *  re-navigates to it instead of leaving the agent on about:blank. */
export function dropTabsForWedgeRecovery(list: TabList, sessionId?: string): void {
	if (sessionId) unregisterAdoptedViews(sessionId);
	const url = list.active.state.url || list.active.lastUrl;
	const owned = list.all().filter((t) => t.owned && t.created && !t.closed);
	for (const tab of owned) {
		tab.closed = true;
		tab.created = false;
		browserLifecycle("close", tab.viewId).catch((e) => {
			logger.warn(`[in-app] wedge close failed (viewId=${tab.viewId}): ${(e as Error).message}`);
		});
	}
	list.resetToFirst();
	if (url) list.active.lastUrl = url;
}

/**
 * Shared navigate/new_tab result text (CDP-shaped): sensitive-page stub wins
 * outright; otherwise `<prefix><url>\nStatus: <code|unknown>\nTitle: …` plus
 * the cross-host redirect warning. `status` is the REAL main-frame HTTP code
 * when the desktop observed one (bridge navigate carries it since chunk E);
 * "unknown" remains the in-family fallback for non-HTTP loads.
 */
export function navigationReport(
	prefix: string,
	result: BrowserNavigateResult,
	requestedHost: string,
): string {
	const sensitive = sensitivePageStub(result.url);
	if (sensitive) return sensitive;
	const redirect = redirectMessage(requestedHost, safeHost(result.url));
	return `${prefix}${result.url}\nStatus: ${result.status ?? "unknown"}\nTitle: ${result.title}${redirect}`;
}

/** Refresh a tab's cached url/title from the live view. Advisory: a failed
 *  ping keeps the last-known values rather than wedging the caller. */
export async function refreshTabState(tab: InAppTab): Promise<void> {
	try {
		const { ping } = await browserLifecycle("ping", tab.viewId);
		if (ping?.ok) {
			if (typeof ping.url === "string") tab.state.url = ping.url;
			if (typeof ping.title === "string") tab.state.title = ping.title;
		}
	} catch (e) {
		logger.warn(`[in-app] ping failed (viewId=${tab.viewId}): ${(e as Error).message}`);
	}
}

/** Close ONLY owned views — adopted (owned:false) tabs are the user's own
 *  browser tabs, never closed, just dropped by resetToFirst. Tolerates
 *  already-gone views (desktop teardown) like the single-view close did. */
export async function closeOwnedTabs(list: TabList, sessionId?: string): Promise<void> {
	if (sessionId) unregisterAdoptedViews(sessionId);
	const owned = list.all().filter((t) => t.owned && t.created && !t.closed);
	for (const tab of owned) {
		tab.closed = true;
		tab.created = false;
		try {
			await browserLifecycle("close", tab.viewId);
		} catch (e) {
			// Closing twice must not fail the caller's cleanup path.
			logger.warn(`[in-app] close failed (viewId=${tab.viewId}): ${(e as Error).message}`);
		}
	}
	list.resetToFirst(); // per-tab registry/state reset lives there
}

/** The desktop reported the USER closed one of this backend's views (tab
 *  strip ✕). Mark the tab gone so the next op's ensureTabView recreates the
 *  view instead of driving a dead viewId. Adopted user tabs keep their own
 *  desktop lifecycle — the existing user tab-close flow covers those. */
export function noteTabClosedExternally(list: TabList, viewId: string): void {
	const tab = list.all().find((t) => t.viewId === viewId && t.owned);
	if (!tab) return;
	tab.closed = true;
	tab.created = false;
	tab.lastUrl = tab.state.url || tab.lastUrl; // the recreated view reloads it
	tab.state.url = "";
	tab.state.title = "";
}

/** Unwind a minted new_tab tab whose NAVIGATION failed (bridge timeout, DNS):
 *  without rollback a ghost blank tab would stay in the list AND remain
 *  active. Close the created view (tolerating an already-gone view, like
 *  closeOwnedTabs), drop the tab, and restore the previous active pointer —
 *  callers rethrow so per-URL loops (multi-URL new_tab) see the failure.
 *  The FIRST-tab materialization (minted === false) is never rolled back —
 *  callers must not invoke this for it. */
export async function rollbackFailedNewTab(list: TabList, tab: InAppTab, prevActive: InAppTab): Promise<void> {
	tab.closed = true;
	tab.created = false;
	try {
		await browserLifecycle("close", tab.viewId);
	} catch (closeErr) {
		logger.warn(`[in-app] rollback close failed (viewId=${tab.viewId}): ${(closeErr as Error).message}`);
	}
	list.rollbackMinted(tab, prevActive);
}
