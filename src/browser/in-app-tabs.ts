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
 */

import type { Page } from "playwright";
import { ObservationRegistry } from "./observation.js";
import { asObservePage, BridgeObservePage, type BridgePageState } from "./in-app-observe.js";
import { browserLifecycle, type BrowserNavigateResult, type BrowserViewInfo } from "./bridge-client.js";
import { profilePartition } from "./profile-store.js";
import { redirectMessage, safeHost } from "./redirect.js";
import { sensitivePageStub } from "./guards.js";
import { createLogger } from "../logger.js";

const logger = createLogger("browser.in-app-tabs");

/** One WebContentsView the backend drives, with its per-tab observation state. */
export class InAppTab {
	created: boolean;
	closed = false;
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

	/** close() bookkeeping: reset every tab's observation state, then drop all
	 *  but the first tab. The new_tab counter is NOT reset — Ns never recur. */
	resetToFirst(): void {
		for (const tab of this.tabs) {
			tab.registry.reset();
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
export async function closeOwnedTabs(list: TabList): Promise<void> {
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

/** One row of the combined ordering `tabs` prints and `switch_tab` indexes. */
export type MergedTab =
	| { kind: "own"; tab: InAppTab; url: string; title: string }
	| { kind: "user"; view: BrowserViewInfo; url: string; title: string };

/**
 * Recompute the combined ordering: this backend's tabs first (list order),
 * then the user's own views (agentDriven === false) not already adopted.
 * Other sessions' agent-driven views are deliberately EXCLUDED — switching
 * onto them would be cross-session interference. Both listTabs and switchTab
 * recompute this merge the same way, so indexes are stable as-of the last
 * `tabs` listing (until views change).
 */
export async function mergeTabs(list: TabList): Promise<MergedTab[]> {
	const merged: MergedTab[] = list
		.all()
		.map((tab) => ({ kind: "own", tab, url: tab.state.url, title: tab.state.title }));
	let views: BrowserViewInfo[] = [];
	try {
		views = (await browserLifecycle("list", "*")).views ?? [];
	} catch (e) {
		// Advisory: the agent's own tabs must stay listable when the pool
		// listing hiccups — degrade to own-tabs-only, loudly.
		logger.warn(`[in-app-tabs] desktop view listing failed: ${(e as Error).message}`);
	}
	for (const view of views) {
		if (view.agentDriven !== false) continue; // other sessions' agent views: excluded
		if (list.has(view.viewId)) continue; // already adopted by this backend
		merged.push({ kind: "user", view, url: view.url, title: view.title });
	}
	return merged;
}

/** Format the merged rows in the page-ops listTabs family, refreshing each
 *  live own tab first so titles/urls aren't stale. Sensitive pages are
 *  withheld by the same rule page-ops applies (guards.sensitivePageStub). */
export async function formatTabsListing(
	list: TabList,
	refresh: (tab: InAppTab) => Promise<void>,
): Promise<string> {
	for (const tab of list.all()) {
		if (tab.created && !tab.closed) await refresh(tab);
	}
	const merged = await mergeTabs(list);
	const rows = merged.map((entry, i) => {
		const active = entry.kind === "own" && entry.tab === list.active ? " ← active" : "";
		const label = sensitivePageStub(entry.url)
			? "[sensitive page withheld]"
			: `${entry.title || "(no title)"} — ${entry.url}`;
		const userMark = entry.kind === "user" ? ` [user tab — switch_tab(${i}) takes control]` : "";
		return `[${i}] ${label}${active}${userMark}`;
	});
	list.lastListing = merged.map((entry) => (entry.kind === "own" ? entry.tab.viewId : entry.view.viewId));
	return `${merged.length} tab(s) open:\n${rows.join("\n")}`;
}

export type MergedSwitchResult =
	| { ok: true; tab: InAppTab }
	| { ok: false; message: string };

/** Resolve a switch over the same combined ordering the listing printed:
 *  an own tab becomes active; a user view is ADOPTED (owned:false) and
 *  becomes active — the takeover seam.
 *
 *  Takeover is PINNED to the last listing: the pool can change between the
 *  `tabs` call and the switch (the human opens/closes tabs), and an index
 *  alone would then silently grab whatever slid into that slot. Adopting a
 *  user view therefore requires a prior listing whose viewId at this index
 *  still matches; a mismatch (or no listing at all) refuses and asks for a
 *  fresh `tabs`. Switches onto the agent's OWN tabs stay index-based — that
 *  list only changes by the agent's own actions. */
export async function switchMergedTab(list: TabList, index: number): Promise<MergedSwitchResult> {
	const merged = await mergeTabs(list);
	if (index < 0 || index >= merged.length) {
		return {
			ok: false,
			message: `Invalid tab index ${index}. Use 'tabs' action to see available tabs (0-${merged.length - 1}).`,
		};
	}
	const entry = merged[index];
	if (entry.kind === "user") {
		const pinned = list.lastListing?.[index];
		if (pinned === undefined) {
			return {
				ok: false,
				message: `Taking control of a user tab requires a current listing. Run 'tabs' first, then switch_tab(${index}).`,
			};
		}
		if (pinned !== entry.view.viewId) {
			return {
				ok: false,
				message: "The browser's tabs changed since the last 'tabs' listing — refusing to take over a tab that may not be the one you meant. Run 'tabs' again and retry.",
			};
		}
	}
	const tab = entry.kind === "own" ? entry.tab : list.adopt(entry.view);
	list.setActive(tab);
	return { ok: true, tab };
}
