/**
 * Merged tab ordering (in-app-tab-merge.ts) — the combined own+user listing,
 * the pinned takeover seam, and close_tab's ownership rules, with the bridge
 * mocked. The tab MODEL's own invariants live in in-app-tabs.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bridge-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./bridge-client.js")>();
	return { ...actual, browserLifecycle: vi.fn() };
});

import { browserLifecycle, type BrowserViewInfo } from "./bridge-client.js";
import { closeMergedTab, formatTabsListing, mergeTabs, switchMergedTab } from "./in-app-tab-merge.js";
import { TabList } from "./in-app-tabs.js";

const FIRST_ID = "view-sess-9-work";

function userView(viewId: string, url: string, title: string): BrowserViewInfo {
	return { viewId, partition: "persist:lax-profile-work", url, title, attached: true, agentDriven: false };
}

function agentView(viewId: string): BrowserViewInfo {
	return { viewId, partition: "persist:lax-profile-work", url: "https://x.example/", title: "X", attached: false, agentDriven: true };
}

function mockList(views: BrowserViewInfo[]): void {
	vi.mocked(browserLifecycle).mockResolvedValue({ views });
}

describe("mergeTabs / formatTabsListing / switchMergedTab", () => {
	let list: TabList;

	beforeEach(() => {
		list = new TabList(FIRST_ID);
		list.active.created = true;
		list.active.state.url = "https://mine.example/";
		list.active.state.title = "Mine";
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("merges own tabs first, then non-adopted user views; agent-driven views are excluded", async () => {
		mockList([agentView("view-other-sess"), userView("view-user-1", "https://u.example/", "U")]);
		const merged = await mergeTabs(list);
		expect(merged).toHaveLength(2);
		expect(merged[0].kind).toBe("own");
		expect(merged[1]).toMatchObject({ kind: "user", url: "https://u.example/" });
	});

	it("excludes user views this backend already adopted (no duplicate rows)", async () => {
		list.adopt(userView("view-user-1", "https://u.example/", "U"));
		mockList([userView("view-user-1", "https://u.example/", "U")]);
		const merged = await mergeTabs(list);
		expect(merged).toHaveLength(2); // first tab + adopted tab, no third row
		expect(merged.every((e) => e.kind === "own")).toBe(true);
	});

	it("degrades to own-tabs-only when the desktop listing fails (agent tabs stay listable)", async () => {
		vi.mocked(browserLifecycle).mockRejectedValue(new Error("bridge down"));
		const merged = await mergeTabs(list);
		expect(merged).toHaveLength(1);
		expect(merged[0].kind).toBe("own");
	});

	it("formats in the page-ops family: active marker, user-tab takeover marker, (no title) fallback", async () => {
		mockList([userView("view-user-1", "https://u.example/", "")]);
		const out = await formatTabsListing(list, async () => { /* refresh mocked out */ });
		expect(out).toBe(
			"2 tab(s) open:\n" +
				"[0] Mine — https://mine.example/ ← active\n" +
				"[1] (no title) — https://u.example/ [user tab — switch_tab(1) takes control]",
		);
	});

	it("withholds sensitive rows by the same rule page-ops uses", async () => {
		mockList([userView("view-user-vault", "https://vault.bitwarden.com/passwords", "My Vault")]);
		const out = await formatTabsListing(list, async () => { /* refresh mocked out */ });
		expect(out).toContain("[1] [sensitive page withheld] [user tab — switch_tab(1) takes control]");
		expect(out).not.toContain("bitwarden");
		expect(out).not.toContain("My Vault");
	});

	it("switchMergedTab activates an own tab by merged index", async () => {
		const t2 = list.openOwned();
		list.setActive(list.all()[0]);
		mockList([]);
		const res = await switchMergedTab(list, 1);
		expect(res).toEqual({ ok: true, tab: t2 });
		expect(list.active).toBe(t2);
	});

	it("switchMergedTab ADOPTS a user view at its merged index (after a listing pinned it)", async () => {
		mockList([userView("view-user-1", "https://u.example/", "U")]);
		await formatTabsListing(list, async () => { /* refresh mocked out */ });
		const res = await switchMergedTab(list, 1);
		expect(res.ok).toBe(true);
		expect(list.active.viewId).toBe("view-user-1");
		expect(list.active.owned).toBe(false);
	});

	it("the ADOPT branch fires browserLifecycle('show', <user viewId>, { sessionId }) so the pane follows the takeover", async () => {
		mockList([userView("view-user-1", "https://u.example/", "U")]);
		await formatTabsListing(list, async () => { /* refresh mocked out */ }); // pins the ordering
		vi.mocked(browserLifecycle).mockClear(); // isolate the switch's own calls (keeps the mockResolvedValue)
		const res = await switchMergedTab(list, 1, "sess-7");
		expect(res.ok).toBe(true);
		expect(list.active.viewId).toBe("view-user-1"); // adopted, owned:false
		// Taking over a user tab is an active-tab change → the desktop is asked to
		// SURFACE it, attributed to the adopting session (fire-and-forget; the show
		// signal must never block or fail the switch, hence the swallowed rejection).
		expect(browserLifecycle).toHaveBeenCalledWith("show", "view-user-1", { sessionId: "sess-7" });
	});

	it("REFUSES to adopt a user view without a prior listing (no pin to verify)", async () => {
		mockList([userView("view-user-1", "https://u.example/", "U")]);
		const res = await switchMergedTab(list, 1);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.message).toContain("requires a current listing");
		expect(list.active.viewId).toBe(FIRST_ID);
	});

	it("REFUSES to adopt when the pool changed since the listing (index now names a different tab)", async () => {
		// Listing sees A at [1]; A closes and B slides into slot [1].
		mockList([userView("view-user-A", "https://a.example/", "A")]);
		await formatTabsListing(list, async () => { /* refresh mocked out */ });
		mockList([userView("view-user-B", "https://b.example/", "B")]);
		const res = await switchMergedTab(list, 1);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.message).toContain("tabs changed since the last 'tabs' listing");
		expect(list.active.viewId).toBe(FIRST_ID);
		// A fresh listing re-pins and the switch then succeeds.
		await formatTabsListing(list, async () => { /* refresh mocked out */ });
		const retry = await switchMergedTab(list, 1);
		expect(retry.ok).toBe(true);
		expect(list.active.viewId).toBe("view-user-B");
	});

	it("own-tab switches stay index-based — no listing required", async () => {
		const t2 = list.openOwned();
		list.setActive(list.all()[0]);
		mockList([]);
		const res = await switchMergedTab(list, 1);
		expect(res).toEqual({ ok: true, tab: t2 });
	});

	it("rejects an out-of-range index with the canonical invalid-index message", async () => {
		mockList([]);
		const res = await switchMergedTab(list, 5);
		expect(res).toEqual({
			ok: false,
			message: "Invalid tab index 5. Use 'tabs' action to see available tabs (0-0).",
		});
	});
});

describe("closeMergedTab — close ONE tab by merged index", () => {
	let list: TabList;

	beforeEach(() => {
		list = new TabList(FIRST_ID);
		list.active.created = true;
		list.active.state.url = "https://mine.example/";
		list.active.state.title = "Mine";
		mockList([]);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	function mintSecond(): ReturnType<TabList["openOwned"]> {
		const t2 = list.openOwned();
		t2.created = true;
		t2.state.url = "https://second.example/";
		t2.state.title = "Second";
		return t2;
	}

	it("closes an owned non-active tab: bridge close fires, tab leaves the list, active pointer untouched", async () => {
		const t2 = mintSecond();
		list.setActive(list.all()[0]);
		const out = await closeMergedTab(list, 1);
		expect(out).toBe("Closed tab [1]: Second — https://second.example/");
		expect(browserLifecycle).toHaveBeenCalledWith("close", t2.viewId);
		expect(list.all()).toHaveLength(1);
		expect(list.active.viewId).toBe(FIRST_ID);
		// No active-tab change → no surface hint.
		expect(vi.mocked(browserLifecycle).mock.calls.filter(([op]) => op === "show")).toHaveLength(0);
	});

	it("closing the ACTIVE tab activates its neighbor, reports it, and SURFACES it", async () => {
		mintSecond(); // active
		const out = await closeMergedTab(list, 1, "sess-7");
		expect(out).toBe(
			"Closed tab [1]: Second — https://second.example/\nActive tab is now: Mine — https://mine.example/",
		);
		expect(list.active.viewId).toBe(FIRST_ID);
		expect(browserLifecycle).toHaveBeenCalledWith("show", FIRST_ID, { sessionId: "sess-7" });
	});

	it("REFUSES to close the session's first tab — that's `close`'s job", async () => {
		mintSecond();
		const out = await closeMergedTab(list, 0);
		expect(out).toContain("first tab");
		expect(out).toContain("'close'");
		expect(list.all()).toHaveLength(2);
		expect(vi.mocked(browserLifecycle).mock.calls.filter(([op]) => op === "close")).toHaveLength(0);
	});

	it("REFUSES to close an ADOPTED user tab (driven, never closed)", async () => {
		const adopted = list.adopt(userView("view-user-1", "https://u.example/", "U"));
		const out = await closeMergedTab(list, 1);
		expect(out).toContain("adopted user tab");
		expect(adopted.closed).toBe(false);
		expect(list.all()).toHaveLength(2);
	});

	it("REFUSES to close an unadopted [user tab] row", async () => {
		mockList([userView("view-user-1", "https://u.example/", "U")]);
		const out = await closeMergedTab(list, 1);
		expect(out).toContain("user's own browser tab");
		expect(vi.mocked(browserLifecycle).mock.calls.filter(([op]) => op === "close")).toHaveLength(0);
	});

	it("rejects an out-of-range index with the canonical invalid-index message", async () => {
		const out = await closeMergedTab(list, 7);
		expect(out).toBe("Invalid tab index 7. Use 'tabs' action to see available tabs (0-0).");
	});

	it("tolerates an already-gone view and still drops the tab from the list", async () => {
		mintSecond();
		const base = vi.mocked(browserLifecycle).getMockImplementation();
		vi.mocked(browserLifecycle).mockImplementation(async (op, id, opts) => {
			if (op === "close") throw new Error("no such view");
			return base ? base(op, id, opts) : { views: [] };
		});
		const out = await closeMergedTab(list, 1);
		expect(out).toContain("Closed tab [1]:");
		expect(list.all()).toHaveLength(1);
	});

	it("invalidates the takeover pin: a listing's stale indexes never survive a close", async () => {
		mintSecond();
		list.setActive(list.all()[0]);
		await formatTabsListing(list, async () => { /* refresh mocked out */ }); // pins
		expect(list.lastListing).not.toBeNull();
		await closeMergedTab(list, 1);
		expect(list.lastListing).toBeNull();
	});

	it("withholds the sensitive label of a closed sensitive tab", async () => {
		const t2 = mintSecond();
		t2.state.url = "https://vault.bitwarden.com/passwords";
		t2.state.title = "My Vault";
		list.setActive(list.all()[0]);
		const out = await closeMergedTab(list, 1);
		expect(out).toBe("Closed tab [1]: [sensitive page withheld]");
		expect(out).not.toContain("bitwarden");
	});
});
