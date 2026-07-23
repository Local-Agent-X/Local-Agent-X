/**
 * In-app tab model (chunk B) — TabList invariants and the merged listing /
 * switch semantics, with the bridge mocked. Backend-level behavior (active-tab
 * routing, close-owned-only over the real call sites) lives in
 * in-app-backend.test.ts; this file pins the model's own contract:
 *   - first tab keeps the legacy viewId and survives close (resetToFirst)
 *   - minted tab numbers are monotonic and never reused
 *   - adoption tracks user views owned:false
 *   - the merge excludes agent-driven views and already-adopted ids,
 *     and degrades to own-tabs-only when the pool listing fails
 *   - formatting matches the page-ops listTabs family, sensitive rows withheld
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bridge-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./bridge-client.js")>();
	return { ...actual, browserLifecycle: vi.fn() };
});

import { browserLifecycle, type BrowserViewInfo } from "./bridge-client.js";
import { formatTabsListing, mergeTabs, switchMergedTab, TabList } from "./in-app-tabs.js";

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

describe("TabList", () => {
	let list: TabList;

	beforeEach(() => {
		list = new TabList(FIRST_ID);
		mockList([]);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("starts with one OWNED tab carrying the exact legacy viewId, active", () => {
		expect(list.all()).toHaveLength(1);
		expect(list.active.viewId).toBe(FIRST_ID);
		expect(list.active.owned).toBe(true);
		expect(list.active.created).toBe(false);
	});

	it("openOwned mints -t2, -t3, … and moves the active pointer", () => {
		const t2 = list.openOwned();
		expect(t2.viewId).toBe(`${FIRST_ID}-t2`);
		expect(t2.owned).toBe(true);
		expect(list.active).toBe(t2);
		const t3 = list.openOwned();
		expect(t3.viewId).toBe(`${FIRST_ID}-t3`);
		expect(list.active).toBe(t3);
	});

	it("never reuses a tab number: resetToFirst keeps the counter monotonic", () => {
		list.openOwned(); // t2
		list.resetToFirst();
		expect(list.all()).toHaveLength(1);
		expect(list.active.viewId).toBe(FIRST_ID);
		expect(list.openOwned().viewId).toBe(`${FIRST_ID}-t3`);
	});

	it("adopt tracks a user view owned:false, created (desktop owns its lifecycle), active", () => {
		const tab = list.adopt(userView("view-user-1", "https://u.example/", "U"));
		expect(tab.owned).toBe(false);
		expect(tab.created).toBe(true);
		expect(tab.state.url).toBe("https://u.example/");
		expect(tab.state.title).toBe("U");
		expect(list.active).toBe(tab);
		expect(list.has("view-user-1")).toBe(true);
	});

	it("remove rolls back a minted tab and restores the previous active; the first tab is irremovable", () => {
		const t2 = list.openOwned();
		list.remove(t2);
		expect(list.all()).toHaveLength(1);
		expect(list.active.viewId).toBe(FIRST_ID);
		list.remove(list.active); // first tab: no-op
		expect(list.all()).toHaveLength(1);
	});

	it("resetToFirst drops adopted and minted tabs, resets every tab's state, and marks the survivor closed", () => {
		const first = list.active;
		first.created = true;
		first.state.url = "https://a.example/";
		list.openOwned();
		list.adopt(userView("view-user-1", "https://u.example/", "U"));
		list.resetToFirst();
		expect(list.all()).toHaveLength(1);
		expect(list.active).toBe(first);
		expect(first.created).toBe(false);
		expect(first.closed).toBe(true);
		expect(first.state.url).toBe("");
	});
});

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
