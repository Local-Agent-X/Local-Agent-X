// @vitest-environment happy-dom
//
// M1: the multi-view switcher in public/js/browser-tab.js. The pool can hold
// several views (the user's foreground view + agent-driven per-(session,profile)
// views); the switcher lists them, badges agent-driven ones, flips which one is
// shown, and stays hidden when there's only one view. The source is an IIFE that
// reads window.desktop.browser + the DOM — we build the DOM, stub the bridge,
// eval the file verbatim, then drive it through window.laxBrowserTab.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "../public/js/browser-tab.js"), "utf8");

interface ViewInfo {
	viewId: string; url: string; title: string; profileId?: string; attached: boolean; agentDriven: boolean;
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

/** Fresh bridge stub whose listViews returns the given fixture. */
function makeBridge(views: ViewInfo[]) {
	return {
		views,
		switchView: vi.fn((viewId: string) => Promise.resolve({
			viewId, url: "https://x/", title: "X", canGoBack: false, canGoForward: false, loading: false,
		})),
		listViews: vi.fn(() => Promise.resolve(views)),
		setBounds: vi.fn(() => Promise.resolve()),
		setVisible: vi.fn(() => Promise.resolve()),
		navigate: vi.fn(),
		goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(),
		getNavState: vi.fn(() => Promise.resolve(null)),
		onNavState: vi.fn(),
	};
}

function loadTab(): void {
	// eslint-disable-next-line no-new-func
	new Function(SRC)();
}

const g = globalThis as unknown as {
	laxBrowserTab: { onTabShown(): void; onTabHidden(): void; refreshSwitcher(): Promise<unknown>; switchTo(id: string): void };
	desktop?: unknown;
};

describe("browser-tab multi-view switcher (M1)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		setDom();
	});
	afterEach(() => {
		vi.useRealTimers();
		delete g.desktop;
	});

	function slot() { return document.getElementById("browser-view-switcher-slot")!; }

	it("renders one pill per view and badges the agent-driven ones", async () => {
		g.desktop = { browser: makeBridge([
			{ viewId: "foreground", url: "https://user/", title: "User", profileId: "default", attached: true, agentDriven: false },
			{ viewId: "view-s1-work", url: "https://job/", title: "Job", profileId: "work", attached: false, agentDriven: true },
		]) };
		loadTab();
		await g.laxBrowserTab.refreshSwitcher();
		const pills = slot().querySelectorAll("button");
		expect(pills.length).toBe(2);
		const labels = [...pills].map((p) => p.textContent);
		expect(labels).toContain("default");            // user foreground, no badge
		expect(labels).toContain("🤖 work");            // agent-driven, badged
	});

	it("hides the switcher when only one view exists", async () => {
		g.desktop = { browser: makeBridge([
			{ viewId: "foreground", url: "https://user/", title: "User", profileId: "default", attached: true, agentDriven: false },
		]) };
		loadTab();
		await g.laxBrowserTab.refreshSwitcher();
		expect(slot().querySelectorAll("button").length).toBe(0);
		expect(slot().innerHTML).toBe("");
	});

	it("clicking a pill calls switchView for that viewId", async () => {
		const bridge = makeBridge([
			{ viewId: "foreground", url: "https://user/", title: "User", profileId: "default", attached: true, agentDriven: false },
			{ viewId: "view-s1-work", url: "https://job/", title: "Job", profileId: "work", attached: false, agentDriven: true },
		]);
		g.desktop = { browser: bridge };
		loadTab();
		await g.laxBrowserTab.refreshSwitcher();
		const agentPill = slot().querySelector('button[data-view-id="view-s1-work"]') as HTMLButtonElement;
		expect(agentPill).toBeTruthy();
		agentPill.click();
		expect(bridge.switchView).toHaveBeenCalledWith("view-s1-work");
	});

	it("onTabShown starts polling; onTabHidden stops it", async () => {
		const bridge = makeBridge([
			{ viewId: "foreground", url: "https://user/", title: "User", profileId: "default", attached: true, agentDriven: false },
			{ viewId: "view-s1-work", url: "https://job/", title: "Job", profileId: "work", attached: false, agentDriven: true },
		]);
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
