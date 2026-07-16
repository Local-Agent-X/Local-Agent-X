// @vitest-environment happy-dom
//
// The Browser-panel tab strip: public/js/browser-tab-strip.js (rendering +
// selection reconciliation) driven by public/js/browser-tab.js (state +
// bridge). The pool can hold several views (the user's foreground view +
// user-<n> tabs + agent-driven per-(session,profile) views); the strip lists
// them ALL — even a single view — badges agent-driven ones, offers a "+"
// new-tab button, flips which view is shown, and re-adopts the attached view
// whenever main retargets it (auto-surface). Both sources are IIFEs that read
// window.desktop.browser + the DOM — we build the DOM, stub the bridge, eval
// the files verbatim in app.html order, then drive window.laxBrowserTab.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const STRIP_SRC = readFileSync(join(here, "../public/js/browser-tab-strip.js"), "utf8");
const TAB_SRC = readFileSync(join(here, "../public/js/browser-tab.js"), "utf8");

interface ViewInfo {
	viewId: string; url: string; title: string; profileId?: string; attached: boolean; agentDriven: boolean;
}

interface NavState {
	viewId: string; url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean;
}

function setDom(): void {
	document.body.innerHTML = `
		<div id="agent-feeds">
			<div id="browser-tab-body">
				<div id="browser-address-bar">
					<button id="browser-nav-back"></button>
					<button id="browser-nav-fwd"></button>
					<button id="browser-nav-reload"></button>
					<input id="browser-url-input" />
					<div id="browser-view-switcher-slot"></div>
				</div>
				<div id="browser-view-anchor"></div>
			</div>
		</div>`;
}

/** Fresh bridge stub whose listViews returns the given (live) fixture array. */
function makeBridge(views: ViewInfo[]) {
	const bridge = {
		views,
		viewsChangedCb: null as null | (() => void),
		navStateCb: null as null | ((state: NavState) => void),
		switchView: vi.fn((viewId: string) => Promise.resolve({
			viewId, url: "https://x/", title: "X", canGoBack: false, canGoForward: false, loading: false,
		})),
		listViews: vi.fn(() => Promise.resolve(views)),
		newTab: vi.fn(() => Promise.resolve({
			viewId: "user-1", url: "about:blank", title: "", canGoBack: false, canGoForward: false, loading: false,
		})),
		onViewsChanged: vi.fn((cb: () => void) => { bridge.viewsChangedCb = cb; }),
		setBounds: vi.fn(() => Promise.resolve()),
		setVisible: vi.fn(() => Promise.resolve()),
		navigate: vi.fn(),
		goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(),
		getNavState: vi.fn(() => Promise.resolve(null)),
		onNavState: vi.fn((cb: (state: NavState) => void) => { bridge.navStateCb = cb; }),
	};
	return bridge;
}

function loadTab(): void {
	// Same order as app.html: strip module first, then the tab module.
	// eslint-disable-next-line no-new-func
	new Function(STRIP_SRC)();
	// eslint-disable-next-line no-new-func
	new Function(TAB_SRC)();
}

/** Drain pending promise chains (microtasks survive fake timers). */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

const g = globalThis as unknown as {
	laxBrowserTab: {
		onTabShown(): void; onTabHidden(): void;
		refreshSwitcher(): Promise<unknown>; switchTo(id: string): void; newTab(): void;
	};
	desktop?: unknown;
};

function slot() { return document.getElementById("browser-view-switcher-slot")!; }
function pills() { return [...slot().querySelectorAll("button[data-view-id]")] as HTMLButtonElement[]; }
function plusButton() { return slot().querySelector("button[data-strip-new-tab]") as HTMLButtonElement | null; }
function activePill() { return slot().querySelector("button.active") as HTMLButtonElement | null; }
function urlInput() { return document.getElementById("browser-url-input") as HTMLInputElement; }

function fgView(over: Partial<ViewInfo> = {}): ViewInfo {
	return { viewId: "foreground", url: "https://user/", title: "User", profileId: "default", attached: true, agentDriven: false, ...over };
}
function agentView(over: Partial<ViewInfo> = {}): ViewInfo {
	return { viewId: "view-s1-work", url: "https://job/", title: "Job", profileId: "work", attached: false, agentDriven: true, ...over };
}

describe("browser-tab tab strip (M1 + chunk D)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		setDom();
	});
	afterEach(() => {
		vi.useRealTimers();
		delete g.desktop;
	});

	it("renders one pill per view, badges agent-driven ones, and appends a + button", async () => {
		g.desktop = { browser: makeBridge([fgView(), agentView()]) };
		loadTab();
		await g.laxBrowserTab.refreshSwitcher();
		expect(pills().length).toBe(2);
		const labels = pills().map((p) => p.textContent);
		expect(labels).toContain("User");     // user foreground: title, no badge
		expect(labels).toContain("🤖 Job");   // agent-driven: title, badged
		expect(plusButton()).toBeTruthy();
		// Attached foreground is the active pill.
		expect(activePill()?.getAttribute("data-view-id")).toBe("foreground");
	});

	it("still shows the strip (pill + +) with a single view — no hide-on-≤1", async () => {
		g.desktop = { browser: makeBridge([fgView()]) };
		loadTab();
		await g.laxBrowserTab.refreshSwitcher();
		expect(pills().length).toBe(1);
		expect(plusButton()).toBeTruthy();
		expect(activePill()?.getAttribute("data-view-id")).toBe("foreground");
	});

	it("labels fall back title → URL host → profileId → 'tab'", async () => {
		g.desktop = { browser: makeBridge([
			fgView({ viewId: "v-title", title: "Docs", url: "https://d.example/x" }),
			fgView({ viewId: "v-host", title: "", url: "https://host.example/p", attached: false }),
			fgView({ viewId: "v-profile", title: "", url: "", profileId: "work", attached: false }),
			fgView({ viewId: "v-bare", title: "", url: "", profileId: undefined, attached: false }),
		]) };
		loadTab();
		await g.laxBrowserTab.refreshSwitcher();
		const byId = new Map(pills().map((p) => [p.getAttribute("data-view-id"), p.textContent]));
		expect(byId.get("v-title")).toBe("Docs");
		expect(byId.get("v-host")).toBe("host.example");
		expect(byId.get("v-profile")).toBe("work");
		expect(byId.get("v-bare")).toBe("tab");
	});

	it("clicking a pill calls switchView for that viewId", async () => {
		const bridge = makeBridge([fgView(), agentView()]);
		g.desktop = { browser: bridge };
		loadTab();
		await g.laxBrowserTab.refreshSwitcher();
		const agentPill = slot().querySelector('button[data-view-id="view-s1-work"]') as HTMLButtonElement;
		expect(agentPill).toBeTruthy();
		agentPill.click();
		expect(bridge.switchView).toHaveBeenCalledWith("view-s1-work");
	});

	it("+ calls newTab, adopts the returned view, and mirrors its nav state", async () => {
		const views = [fgView()];
		const bridge = makeBridge(views);
		// Mimic main: browser-new-tab mints + attaches the view BEFORE resolving,
		// so a listViews issued after resolution already reports it attached.
		bridge.newTab.mockImplementation(() => {
			views[0].attached = false;
			views.push(fgView({ viewId: "user-1", url: "about:blank", title: "", attached: true }));
			return Promise.resolve({
				viewId: "user-1", url: "about:blank", title: "", canGoBack: false, canGoForward: false, loading: false,
			});
		});
		g.desktop = { browser: bridge };
		loadTab();
		await g.laxBrowserTab.refreshSwitcher();
		plusButton()!.click();
		await flushMicrotasks();
		expect(bridge.newTab).toHaveBeenCalledTimes(1);
		expect(urlInput().value).toBe("about:blank");
		expect(pills().length).toBe(2);
		expect(activePill()?.getAttribute("data-view-id")).toBe("user-1");
	});

	it("re-adopts the attached view after main auto-surfaces an agent view (views-changed poke)", async () => {
		const views = [fgView(), agentView()];
		const bridge = makeBridge(views);
		g.desktop = { browser: bridge };
		loadTab();
		await g.laxBrowserTab.refreshSwitcher();
		expect(activePill()?.getAttribute("data-view-id")).toBe("foreground");
		// Main retargets: agent view attached, foreground detached.
		views[0].attached = false;
		views[1].attached = true;
		views[1].url = "https://agent.example/run";
		expect(bridge.viewsChangedCb).toBeTypeOf("function"); // wired at init
		bridge.viewsChangedCb!();
		await flushMicrotasks();
		expect(activePill()?.getAttribute("data-view-id")).toBe("view-s1-work");
		expect(urlInput().value).toBe("https://agent.example/run");
	});

	it("re-adoption fetches FULL nav state — back/fwd reflect the adopted view's history, not stuck disabled", async () => {
		// The pool entry carries only {viewId, url}; an IDLE view never pushes
		// another nav-state. Without the getNavState() refill, back/fwd would
		// stay disabled forever on an auto-surfaced idle agent view.
		const views = [fgView(), agentView()];
		const bridge = makeBridge(views);
		bridge.getNavState = vi.fn(() => Promise.resolve({
			viewId: "view-s1-work", url: "https://agent.example/run", title: "Run",
			canGoBack: true, canGoForward: false, loading: false,
		}));
		g.desktop = { browser: bridge };
		loadTab();
		await g.laxBrowserTab.refreshSwitcher();
		views[0].attached = false;
		views[1].attached = true;
		views[1].url = "https://agent.example/run";
		bridge.viewsChangedCb!();
		await flushMicrotasks();
		expect(bridge.getNavState).toHaveBeenCalled();
		const back = document.getElementById("browser-nav-back") as HTMLButtonElement;
		expect(back.disabled).toBe(false);
	});

	it("the 2s poll also re-adopts the attached view (fallback path)", async () => {
		const views = [fgView(), agentView()];
		const bridge = makeBridge(views);
		g.desktop = { browser: bridge };
		loadTab();
		g.laxBrowserTab.onTabShown();
		await flushMicrotasks();
		views[0].attached = false;
		views[1].attached = true;
		views[1].url = "https://agent.example/poll";
		await vi.advanceTimersByTimeAsync(2000);
		expect(activePill()?.getAttribute("data-view-id")).toBe("view-s1-work");
		expect(urlInput().value).toBe("https://agent.example/poll");
		g.laxBrowserTab.onTabHidden();
	});

	it("nav-state pushes for the newly adopted view update the UI; other views' are dropped", async () => {
		const views = [fgView(), agentView()];
		const bridge = makeBridge(views);
		g.desktop = { browser: bridge };
		loadTab();
		await g.laxBrowserTab.refreshSwitcher();
		views[0].attached = false;
		views[1].attached = true;
		bridge.viewsChangedCb!();
		await flushMicrotasks();
		// Tagged push for the adopted agent view drives the address bar + buttons.
		bridge.navStateCb!({
			viewId: "view-s1-work", url: "https://agent.example/step2", title: "Step 2",
			canGoBack: true, canGoForward: false, loading: false,
		});
		expect(urlInput().value).toBe("https://agent.example/step2");
		expect((document.getElementById("browser-nav-back") as HTMLButtonElement).disabled).toBe(false);
		// A push tagged with the now-background foreground view is ignored.
		bridge.navStateCb!({
			viewId: "foreground", url: "https://user/elsewhere", title: "User",
			canGoBack: false, canGoForward: false, loading: false,
		});
		expect(urlInput().value).toBe("https://agent.example/step2");
	});

	it("re-adoption never clobbers a URL the user is mid-typing", async () => {
		const views = [fgView(), agentView()];
		const bridge = makeBridge(views);
		g.desktop = { browser: bridge };
		loadTab();
		await g.laxBrowserTab.refreshSwitcher();
		const input = urlInput();
		input.focus();
		input.value = "half-typed.example";
		views[0].attached = false;
		views[1].attached = true;
		views[1].url = "https://agent.example/run";
		bridge.viewsChangedCb!();
		await flushMicrotasks();
		// Selection followed the attach flip, but the typed text survives.
		expect(activePill()?.getAttribute("data-view-id")).toBe("view-s1-work");
		expect(input.value).toBe("half-typed.example");
	});

	it("onTabShown starts polling; onTabHidden stops it", async () => {
		const bridge = makeBridge([fgView(), agentView()]);
		g.desktop = { browser: bridge };
		loadTab();
		bridge.listViews.mockClear();
		g.laxBrowserTab.onTabShown();          // immediate refresh + interval
		expect(bridge.listViews).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(4000);          // two polls
		expect(bridge.listViews.mock.calls.length).toBeGreaterThanOrEqual(3);
		g.laxBrowserTab.onTabHidden();
		const after = bridge.listViews.mock.calls.length;
		vi.advanceTimersByTime(4000);          // no further polling
		expect(bridge.listViews.mock.calls.length).toBe(after);
	});
});
