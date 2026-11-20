// @vitest-environment happy-dom
// The Browser pane's permission bar (browser-permission-bar.js), driven with
// the real browser-tab.js in app.html's load order against a fake bridge.
//
// Live 2026-11-19: a modal said "https://lpcdn-vip.lpsnmedia.net wants
// permission to use storage-access" over microsoft.com, about its chat widget.
// Such a request is now blocked quietly, and this bar is where the user sees
// it and can undo it — so a block never happens where nobody can see it.
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BAR_SRC = readFileSync(join(here, "../public/js/browser-permission-bar.js"), "utf8");
const TAB_SRC = readFileSync(join(here, "../public/js/browser-tab.js"), "utf8");

let navCbs: Array<(state: unknown) => void>;
let blocked: ((notice: unknown) => void) | null;
let allowPermission: Mock;

const NOTICE = {
	viewId: "foreground",
	origin: "https://lpcdn-vip.lpsnmedia.net",
	permission: "storage-access",
	text: "Something embedded in microsoft.com (from lpcdn-vip.lpsnmedia.net) wanted to remember you here.",
};

function nav(viewId: string, url: string) {
	const state = { viewId, url, title: "", canGoBack: false, canGoForward: false, loading: false, loadError: null };
	for (const cb of navCbs) cb(state);
}

const bar = () => document.getElementById("browser-permission-bar");
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function load(withBridge = true) {
	document.body.innerHTML = `
		<div id="agent-feeds">
			<div id="browser-tab-body">
				<div id="browser-address-bar"><input id="browser-url-input" type="text"></div>
				<div id="browser-view-anchor"></div>
			</div>
		</div>`;
	navCbs = [];
	blocked = null;
	allowPermission = vi.fn().mockResolvedValue(true);
	(window as unknown as { desktop: unknown }).desktop = withBridge ? {
		isDesktop: true,
		browser: {
			setBounds: vi.fn(), setVisible: vi.fn(), navigate: vi.fn(), goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(),
			getNavState: vi.fn().mockResolvedValue(null),
			onNavState: vi.fn((cb: (state: unknown) => void) => { navCbs.push(cb); }),
			onPermissionBlocked: vi.fn((cb: (notice: unknown) => void) => { blocked = cb; }),
			allowPermission,
		},
	} : undefined;
	// app.html order: the bar loads before the tab module that notifies it.
	new Function(BAR_SRC)();
	new Function(TAB_SRC)();
}

beforeEach(() => load());

describe("the permission bar", () => {
	it("shows the selected tab's block as a row above the page, not over it", () => {
		nav("foreground", "https://www.microsoft.com/onedrive"); // browser-tab adopts → tells the bar
		blocked!(NOTICE);
		const el = bar()!;
		expect(el.style.display).toBe("");
		expect(el.textContent).toContain("Blocked: Something embedded in microsoft.com");
		// A flow row before the anchor: overlaying the native page would hide it.
		expect(el.nextElementSibling?.id).toBe("browser-view-anchor");
		expect([...el.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Allow", "✕"]);
	});

	it("keeps another tab's block until that tab is selected", () => {
		nav("foreground", "https://example.com/");
		blocked!({ ...NOTICE, viewId: "user-2" });
		expect(bar()?.style.display ?? "none").toBe("none");
		(window as unknown as { laxBrowserPermissionBar: { onViewSelected(id: string): void } })
			.laxBrowserPermissionBar.onViewSelected("user-2");
		expect(bar()!.textContent).toContain("Blocked:");
	});

	it("shows one row per site and permission, however often the page asks", () => {
		nav("foreground", "https://www.microsoft.com/");
		blocked!(NOTICE);
		blocked!(NOTICE);
		expect(bar()!.querySelectorAll(".browser-permission-row")).toHaveLength(1);
	});

	it("Allow asks main to grant exactly that request, then drops the row", async () => {
		nav("foreground", "https://www.microsoft.com/");
		blocked!(NOTICE);
		(bar()!.querySelector("button") as HTMLButtonElement).click();
		await flush();
		expect(allowPermission).toHaveBeenCalledWith("foreground", NOTICE.origin, "storage-access");
		expect(bar()!.style.display).toBe("none");
	});

	it("keeps the row when main refuses the grant", async () => {
		allowPermission.mockResolvedValue(false);
		nav("foreground", "https://www.microsoft.com/");
		blocked!(NOTICE);
		const allow = bar()!.querySelector("button") as HTMLButtonElement;
		allow.click();
		await flush();
		expect(bar()!.style.display).toBe("");
	});

	it("Dismiss closes the row and grants nothing", () => {
		nav("foreground", "https://www.microsoft.com/");
		blocked!(NOTICE);
		(bar()!.querySelectorAll("button")[1] as HTMLButtonElement).click();
		expect(bar()!.style.display).toBe("none");
		expect(allowPermission).not.toHaveBeenCalled();
	});

	it("drops a tab's rows when it moves to another site, keeps them within the site", () => {
		nav("foreground", "https://www.microsoft.com/a");
		blocked!(NOTICE);
		nav("foreground", "https://www.microsoft.com/b");
		expect(bar()!.style.display).toBe("");
		nav("foreground", "https://news.example/");
		expect(bar()!.style.display).toBe("none");
	});

	it("does nothing in a plain browser with no desktop bridge", () => {
		expect(() => load(false)).not.toThrow();
		expect(bar()).toBeNull();
	});
});
