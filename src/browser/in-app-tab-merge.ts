/**
 * Merged tab ordering + takeover + single-tab close — split from
 * in-app-tabs.ts for the 400-LOC ceiling. This module owns everything indexed
 * by the COMBINED ordering the `tabs` action prints: the merge itself
 * (own tabs first, then the user's own views), the listing format, switch/
 * adopt (the takeover seam, pinned to the last listing), close_tab's
 * ownership rules, and the surface hint that keeps the visible pane on the
 * agent's active tab. The tab MODEL (InAppTab/TabList and per-view lifecycle)
 * stays in in-app-tabs.ts.
 */

import { browserLifecycle, type BrowserViewInfo } from "./bridge-client.js";
import { sensitivePageStub } from "./guards.js";
import { registerAdoptedView } from "./bridge-perception.js";
import { TabList, type InAppTab } from "./in-app-tabs.js";
import { createLogger } from "../logger.js";

const logger = createLogger("browser.in-app-tab-merge");

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
	let views: BrowserViewInfo[] = [];
	try {
		views = (await browserLifecycle("list", "*")).views ?? [];
	} catch (e) {
		// Advisory: the agent's own tabs must stay listable when the pool
		// listing hiccups — degrade to own-tabs-only, loudly.
		logger.warn(`[in-app-tabs] desktop view listing failed: ${(e as Error).message}`);
	}
	const liveById = new Map(views.map((view) => [view.viewId, view]));
	const merged: MergedTab[] = [];
	for (const [index, tab] of list.all().entries()) {
		const live = liveById.get(tab.viewId);
		if (live?.agentDriven === true) {
			tab.created = true;
			tab.closed = false;
			tab.state.url = live.url;
			tab.state.title = live.title;
		}
		if (index === 0 && (!tab.created || tab.closed)) continue;
		merged.push({ kind: "own", tab, url: tab.state.url, title: tab.state.title });
	}
	for (const view of views) {
		if (view.agentDriven !== false) continue; // other sessions' agent views: excluded
		if (list.has(view.viewId)) continue; // already adopted by this backend
		merged.push({ kind: "user", view, url: view.url, title: view.title });
	}
	return merged;
}

/** The withheld-or-plain row label both the listing and close_tab print. */
function tabLabel(url: string, title: string): string {
	return sensitivePageStub(url) ? "[sensitive page withheld]" : `${title || "(no title)"} — ${url}`;
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
	if (merged.length === 0) {
		list.lastListing = null;
		return "No browser session active.";
	}
	const rows = merged.map((entry, i) => {
		const active = entry.kind === "own" && entry.tab === list.active ? " ← active" : "";
		const label = tabLabel(entry.url, entry.title);
		const userMark = entry.kind === "user" ? ` [user tab — switch_tab(${i}) takes control]` : "";
		return `[${i}] ${label}${active}${userMark}`;
	});
	list.lastListing = merged.map((entry) => (entry.kind === "own" ? entry.tab.viewId : entry.view.viewId));
	return `${merged.length} tab(s) open:\n${rows.join("\n")}`;
}

export type MergedSwitchResult =
	| { ok: true; tab: InAppTab }
	| { ok: false; message: string };

/** Fire-and-forget: ask the desktop to SURFACE the agent's new active view so
 *  the visible browser pane FOLLOWS the agent's active tab whenever it changes
 *  (new_tab / switch_tab / close_tab). A UI-surface hint must NEVER block or
 *  fail the tool action, so a vanished view or an unavailable bridge is
 *  swallowed — the desktop side (browser-ipc autoSurfaceAgentView) owns the
 *  "follow the agent but never steal a real user page" policy. Only the
 *  agent's OWN active-tab change fires this; merely LISTING adopted user tabs
 *  must not. */
export function surfaceActiveTab(viewId: string, sessionId?: string): void {
	browserLifecycle("show", viewId, { sessionId }).catch(() => { /* UI hint — never fails the action */ });
}

/** Resolve a switch over the same combined ordering the listing printed:
 *  an own tab becomes active; a user view is ADOPTED (owned:false) and
 *  becomes active — the takeover seam.
 *
 *  Switching is PINNED to the last listing: the pool can change between the
 *  `tabs` call and the switch, and adopting/opening a view also changes the
 *  merged ordering. The listed viewId must still match, and a successful
 *  switch consumes the listing so a second stale index cannot be reused. */
export async function switchMergedTab(list: TabList, index: number, sessionId?: string): Promise<MergedSwitchResult> {
	const merged = await mergeTabs(list);
	if (index < 0 || index >= merged.length) {
		return {
			ok: false,
			message: `Invalid tab index ${index}. Use 'tabs' action to see available tabs (0-${merged.length - 1}).`,
		};
	}
	const entry = merged[index];
	const pinnedViewId = list.lastListing?.[index];
	const currentViewId = entry.kind === "own" ? entry.tab.viewId : entry.view.viewId;
	if (pinnedViewId === undefined) {
		return {
			ok: false,
			message: `Switching tabs requires a current listing. Run 'tabs' first, then switch_tab(${index}).`,
		};
	}
	if (pinnedViewId !== currentViewId) {
		return {
			ok: false,
			message: "The browser's tabs changed since the last 'tabs' listing. Run 'tabs' again and retry.",
		};
	}
	list.lastListing = null;
	if (entry.kind === "own") {
		list.setActive(entry.tab);
		surfaceActiveTab(entry.tab.viewId, sessionId); // the active tab moved — the visible pane follows it
		return { ok: true, tab: entry.tab };
	}
	const tab = list.adopt(entry.view);
	list.setActive(tab);
	// Attribution follows the takeover: downloads the agent triggers on this
	// user view must land in the adopting session's records.
	if (sessionId) registerAdoptedView(tab.viewId, sessionId);
	surfaceActiveTab(tab.viewId, sessionId); // taking over a user tab is an active-tab change — surface it
	return { ok: true, tab };
}

/** Close ONE agent-owned tab by its merged index (the ordering `tabs` prints).
 *  Ownership rules: a user view — adopted or not — is never closed by the
 *  agent, and the FIRST tab (the legacy-viewId view that anchors adoption of
 *  prior sessions' views) only goes down with the whole session via `close`.
 *  Closing the active tab activates its list neighbor (TabList.remove's
 *  pointer adjustment) and surfaces it so the visible pane follows. */
export async function closeMergedTab(list: TabList, index: number, sessionId?: string): Promise<string> {
	const merged = await mergeTabs(list);
	if (index < 0 || index >= merged.length) {
		return `Invalid tab index ${index}. Use 'tabs' action to see available tabs (0-${merged.length - 1}).`;
	}
	const entry = merged[index];
	if (entry.kind === "user") {
		return `Tab [${index}] is the user's own browser tab — the agent never closes user tabs. Only tabs this session opened can be closed.`;
	}
	const tab = entry.tab;
	if (!tab.owned) {
		return `Tab [${index}] is an adopted user tab — the agent drives it but never closes it. It stays with the user; use switch_tab to move off it instead.`;
	}
	if (tab === list.all()[0]) {
		return `Tab [${index}] is the session's first tab — close_tab can't remove it. Use 'close' to end the whole browser session.`;
	}
	const wasActive = list.active === tab;
	const label = tabLabel(tab.state.url, tab.state.title);
	const needsClose = tab.created && !tab.closed;
	tab.closed = true;
	tab.created = false;
	if (needsClose) {
		try {
			await browserLifecycle("close", tab.viewId);
		} catch (e) {
			// Tolerate an already-gone view (desktop teardown), like closeOwnedTabs.
			logger.warn(`[in-app] close_tab failed (viewId=${tab.viewId}): ${(e as Error).message}`);
		}
	}
	list.remove(tab);
	list.lastListing = null; // indexes shifted — a stale pin must never authorize a takeover
	if (!wasActive) return `Closed tab [${index}]: ${label}`;
	const next = list.active;
	surfaceActiveTab(next.viewId, sessionId); // the active tab changed — the visible pane follows it
	return `Closed tab [${index}]: ${label}\nActive tab is now: ${tabLabel(next.state.url, next.state.title)}`;
}
