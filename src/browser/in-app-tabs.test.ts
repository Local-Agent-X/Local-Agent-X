/**
 * In-app tab model (chunk B) — TabList invariants with the bridge mocked.
 * Backend-level behavior (active-tab routing, close-owned-only over the real
 * call sites) lives in in-app-backend.test.ts; the merged listing / switch /
 * close_tab semantics live in in-app-tab-merge.test.ts beside their module.
 * This file pins the model's own contract:
 *   - first tab keeps the legacy viewId and survives close (resetToFirst)
 *   - minted tab numbers are monotonic and never reused
 *   - adoption tracks user views owned:false
 *   - external-close bookkeeping preserves the URL for the recreate reload
 *   - new_tab rollback closes the ghost view and restores the active pointer
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bridge-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./bridge-client.js")>();
	return { ...actual, browserLifecycle: vi.fn() };
});

import { browserLifecycle, type BrowserViewInfo } from "./bridge-client.js";
import { noteTabClosedExternally, refreshTabState, rollbackFailedNewTab, TabList } from "./in-app-tabs.js";

const FIRST_ID = "view-sess-9-work";

function userView(viewId: string, url: string, title: string): BrowserViewInfo {
	return { viewId, partition: "persist:lax-profile-work", url, title, attached: true, agentDriven: false };
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

describe("viewport bounds over the ping (real WebContentsView size, not 1280×800)", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("viewportSize() is null before any ping — extract's 1280×800 default applies", () => {
		const list = new TabList(FIRST_ID);
		expect(list.active.page.viewportSize()).toBeNull();
	});

	it("refreshTabState stamps url/title AND the view's real bounds; viewportSize() serves them", async () => {
		const list = new TabList(FIRST_ID);
		const tab = list.active;
		tab.created = true;
		vi.mocked(browserLifecycle).mockResolvedValue({
			ping: { ok: true, url: "https://a.example/", title: "A", bounds: { width: 1024, height: 640 } },
		});
		await refreshTabState(tab);
		expect(tab.state.url).toBe("https://a.example/");
		expect(tab.state.title).toBe("A");
		expect(tab.page.viewportSize()).toEqual({ width: 1024, height: 640 });
	});

	it("a ping WITHOUT bounds (older desktop build) keeps the last-known viewport", async () => {
		const list = new TabList(FIRST_ID);
		const tab = list.active;
		tab.created = true;
		vi.mocked(browserLifecycle).mockResolvedValue({
			ping: { ok: true, url: "https://a.example/", title: "A", bounds: { width: 1024, height: 640 } },
		});
		await refreshTabState(tab);
		vi.mocked(browserLifecycle).mockResolvedValue({ ping: { ok: true, url: "https://b.example/", title: "B" } });
		await refreshTabState(tab);
		expect(tab.state.url).toBe("https://b.example/");
		expect(tab.page.viewportSize()).toEqual({ width: 1024, height: 640 });
	});
});

describe("noteTabClosedExternally / rollbackFailedNewTab", () => {
	let list: TabList;

	beforeEach(() => {
		list = new TabList(FIRST_ID);
		mockList([]);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("marks an OWNED tab gone and preserves its URL for the recreate reload", () => {
		const tab = list.active;
		tab.created = true;
		tab.state.url = "https://a.example/";
		tab.state.title = "A";
		noteTabClosedExternally(list, FIRST_ID);
		expect(tab.closed).toBe(true);
		expect(tab.created).toBe(false);
		expect(tab.lastUrl).toBe("https://a.example/"); // ensureTabView reloads it
		expect(tab.state.url).toBe("");
	});

	it("ignores adopted user views (their lifecycle belongs to the desktop)", () => {
		const adopted = list.adopt(userView("view-user-1", "https://u.example/", "U"));
		noteTabClosedExternally(list, "view-user-1");
		expect(adopted.closed).toBe(false);
		expect(adopted.created).toBe(true);
	});

	it("rollbackFailedNewTab closes the ghost view, drops the tab, and restores the previous active", async () => {
		const first = list.active;
		const minted = list.openOwned();
		minted.created = true;
		await rollbackFailedNewTab(list, minted, first);
		expect(browserLifecycle).toHaveBeenCalledWith("close", minted.viewId);
		expect(list.all()).toHaveLength(1);
		expect(list.active).toBe(first);
	});

	it("rollbackFailedNewTab tolerates an already-gone view (close rejection is swallowed)", async () => {
		const first = list.active;
		const minted = list.openOwned();
		vi.mocked(browserLifecycle).mockRejectedValueOnce(new Error("no such view"));
		await expect(rollbackFailedNewTab(list, minted, first)).resolves.toBeUndefined();
		expect(list.all()).toHaveLength(1);
		expect(list.active).toBe(first);
	});
});
