// @vitest-environment happy-dom
//
// Chat links → in-app browser pane: public/js/chat-link-open.js intercepts
// left-clicks on external http(s) chat links and opens them as USER tabs in
// the Browser panel (via window.laxBrowserTab.openUrl), with a right-click
// menu offering the external-browser escape hatch. Loopback/file links and
// modified clicks keep the default (main-process window-open) path. Same
// eval-the-file-verbatim idiom as browser-tab-switcher.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const LINK_SRC = readFileSync(join(here, "../public/js/chat-link-open.js"), "utf8");

const g = globalThis as unknown as {
	desktop?: { browser?: Record<string, unknown> };
	laxBrowserTab?: { openUrl: (url: string) => void };
	switchSidePanelTab?: (tab: string) => void;
	open?: (url?: string, target?: string, features?: string) => unknown;
};

function setDom(): void {
	document.body.innerHTML = `<div id="messages"></div>`;
}

function loadModule(): void {
	// eslint-disable-next-line no-new-func
	new Function(LINK_SRC)();
}

function addLink(href: string, cls = "md-link"): HTMLAnchorElement {
	const a = document.createElement("a");
	a.className = cls;
	a.setAttribute("href", href);
	a.textContent = href;
	document.getElementById("messages")!.appendChild(a);
	return a;
}

function click(el: HTMLElement, init: MouseEventInit = {}): MouseEvent {
	const e = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
	el.dispatchEvent(e);
	return e;
}

function rightClick(el: HTMLElement): MouseEvent {
	const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
	el.dispatchEvent(e);
	return e;
}

function menu(): HTMLElement | null {
	return document.querySelector(".link-menu");
}

function menuItem(label: string): HTMLElement {
	const items = [...document.querySelectorAll(".link-menu-item")] as HTMLElement[];
	const hit = items.find((i) => i.textContent === label);
	if (!hit) throw new Error(`menu item not found: ${label}`);
	return hit;
}

describe("chat-link-open — chat links open in the in-app browser pane", () => {
	let openUrl: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		setDom();
		g.desktop = { browser: { newTab: vi.fn() } };
		openUrl = vi.fn();
		g.laxBrowserTab = { openUrl };
		loadModule();
	});

	afterEach(() => {
		delete g.desktop;
		delete g.laxBrowserTab;
		document.querySelectorAll(".link-menu").forEach((m) => m.remove());
	});

	it("left-click on an external chat link opens it in-app and prevents the default", () => {
		const a = addLink("https://news.ycombinator.com/item?id=1");
		const e = click(a);
		expect(e.defaultPrevented).toBe(true);
		expect(openUrl).toHaveBeenCalledWith("https://news.ycombinator.com/item?id=1");
	});

	it.each([
		["ctrl", { ctrlKey: true }],
		["meta", { metaKey: true }],
		["shift", { shiftKey: true }],
		["alt", { altKey: true }],
	])("%s-click keeps the default (external) path", (_label, init) => {
		const a = addLink("https://example.com/");
		const e = click(a, init as MouseEventInit);
		expect(e.defaultPrevented).toBe(false);
		expect(openUrl).not.toHaveBeenCalled();
	});

	it.each([
		["loopback ip", "http://127.0.0.1:7007/settings"],
		["localhost", "http://localhost:5173/"],
		["non-http scheme", "mailto:x@y.z"],
	])("never diverts %s links", (_label, href) => {
		const a = addLink(href);
		const e = click(a);
		expect(e.defaultPrevented).toBe(false);
		expect(openUrl).not.toHaveBeenCalled();
	});

	it("file links keep their download/system-open flow", () => {
		const a = addLink("https://example.com/report", "md-link file-download");
		const e = click(a);
		expect(e.defaultPrevented).toBe(false);
		expect(openUrl).not.toHaveBeenCalled();
	});

	it("non-chat clicks pass through untouched", () => {
		const div = document.createElement("div");
		document.getElementById("messages")!.appendChild(div);
		const e = click(div);
		expect(e.defaultPrevented).toBe(false);
	});

	it("right-click shows the menu; 'Open in external browser' rides window.open", () => {
		const a = addLink("https://example.com/docs");
		const winOpen = vi.fn();
		g.open = winOpen;
		const e = rightClick(a);
		expect(e.defaultPrevented).toBe(true);
		expect(menu()).not.toBeNull();
		menuItem("Open in external browser").click();
		expect(winOpen).toHaveBeenCalledWith("https://example.com/docs", "_blank", "noopener");
		expect(menu()).toBeNull(); // dismissed after the pick
	});

	it("right-click menu 'Open in app browser' routes to the pane", () => {
		const a = addLink("https://example.com/docs");
		rightClick(a);
		menuItem("Open in app browser").click();
		expect(openUrl).toHaveBeenCalledWith("https://example.com/docs");
	});

	it("Escape and outside-click dismiss the menu", () => {
		const a = addLink("https://example.com/");
		rightClick(a);
		expect(menu()).not.toBeNull();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expect(menu()).toBeNull();
		rightClick(a);
		expect(menu()).not.toBeNull();
		document.body.click();
		expect(menu()).toBeNull();
	});

	it("a loopback link keeps the NATIVE context menu (no custom menu)", () => {
		const a = addLink("http://127.0.0.1:7007/files/x.pdf");
		const e = rightClick(a);
		expect(e.defaultPrevented).toBe(false);
		expect(menu()).toBeNull();
	});
});

describe("chat-link-open — plain-browser mode", () => {
	it("no desktop bridge → module no-ops and links keep their default behavior", () => {
		setDom();
		delete g.desktop;
		g.laxBrowserTab = { openUrl: vi.fn() };
		loadModule();
		const a = addLink("https://example.com/");
		const e = click(a);
		expect(e.defaultPrevented).toBe(false);
		expect(g.laxBrowserTab.openUrl).not.toHaveBeenCalled();
	});
});
