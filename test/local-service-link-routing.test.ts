// Chat links to loopback URLs on a NON-LAX port (a ComfyUI the agent started
// on :8188, a dev server, a local model UI) must open in the in-app browser.
// The desktop window-open handler (desktop/src/app-windows.ts) classifies such
// URLs as neither external (hostname is loopback → no system browser) nor ours
// (different port → no /files//apps handling) and DENIES them — so unless the
// renderer intercepts the click, it silently does nothing. That dead click is
// the regression this file guards.
//
// The interception lives in public/js/shared-dom.js (the canonical renderer
// link-click router) and routes through the canonical tab mint,
// window.desktop.browser.newTab — no parallel open path.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const APP_ORIGIN = "http://127.0.0.1:8080";
const src = readFileSync(join(here, "../public/js/shared-dom.js"), "utf8");

interface Harness {
	win: Record<string, unknown> & { isLocalServiceLink?: (href: string, origin: string) => boolean };
	clickHandlers: Array<(e: unknown) => void>;
	newTab: ReturnType<typeof vi.fn>;
	switchTab: ReturnType<typeof vi.fn>;
	toggleFeeds: ReturnType<typeof vi.fn>;
}

function loadSharedDom(opts: { desktop?: unknown; feedsOpen?: boolean } = {}): Harness {
	const clickHandlers: Array<(e: unknown) => void> = [];
	const doc = {
		addEventListener: (type: string, fn: (e: unknown) => void) => {
			if (type === "click") clickHandlers.push(fn);
		},
		getElementById: () => null,
	};
	const newTab = vi.fn();
	const desktop =
		opts.desktop !== undefined ? opts.desktop : { isDesktop: true, browser: { newTab } };
	const win: Harness["win"] = { desktop, open: vi.fn() };
	const location = { origin: APP_ORIGIN, href: `${APP_ORIGIN}/app.html` };
	const switchTab = vi.fn();
	const toggleFeeds = vi.fn();
	new Function(
		"document", "window", "location",
		"switchSidePanelTab", "toggleAgentFeeds", "agentFeedsOpen",
		src,
	)(doc, win, location, switchTab, toggleFeeds, opts.feedsOpen === true);
	return { win, clickHandlers, newTab, switchTab, toggleFeeds };
}

// A click event whose target sits inside an <a>. closest() resolves the way
// the real DOM would for the two selectors shared-dom.js uses.
function clickOn(href: string, classes: string[] = ["md-link"]) {
	const anchor = {
		href,
		classList: { contains: (c: string) => classes.includes(c) },
		closest: (sel: string) => (sel === ".file-download" && !classes.includes("file-download") ? null : anchor),
		getAttribute: (name: string) => (name === "href" ? href : null),
	};
	let prevented = false;
	const event = {
		target: {
			closest: (sel: string) => {
				if (sel === "a[href]") return anchor;
				if (sel === ".file-download") return classes.includes("file-download") ? anchor : null;
				return null;
			},
		},
		preventDefault: () => { prevented = true; },
		get defaultPrevented() { return prevented; },
	};
	return { event, wasPrevented: () => prevented };
}

function dispatch(h: Harness, href: string, classes?: string[]) {
	const { event, wasPrevented } = clickOn(href, classes);
	for (const fn of h.clickHandlers) fn(event);
	return wasPrevented();
}

describe("isLocalServiceLink classifier", () => {
	const h = loadSharedDom();
	const isLocal = (href: string) => h.win.isLocalServiceLink!(href, APP_ORIGIN);

	it("loopback URLs on a non-LAX port are local services", () => {
		expect(isLocal("http://127.0.0.1:8188/")).toBe(true);
		expect(isLocal("http://localhost:3000/dashboard")).toBe(true);
		expect(isLocal("http://[::1]:9000/")).toBe(true);
	});

	it("LAX's own origin is not diverted (files//apps handling owns it)", () => {
		expect(isLocal(`${APP_ORIGIN}/files/report.md`)).toBe(false);
	});

	it("external and non-http URLs are not diverted", () => {
		expect(isLocal("https://example.com/")).toBe(false);
		// OAuth-style URL carrying a loopback redirect_uri in its QUERY must not
		// be misread as local (same trap url-classify.ts documents).
		expect(isLocal("https://accounts.x.ai/authorize?redirect_uri=http://127.0.0.1:7000/cb")).toBe(false);
		expect(isLocal("mailto:a@b.c")).toBe(false);
		expect(isLocal("not a url")).toBe(false);
	});
});

describe("chat-link click routing", () => {
	it("loopback non-LAX link → in-app browser tab + BROWSER panel surfaced", () => {
		const h = loadSharedDom({ feedsOpen: false });
		const prevented = dispatch(h, "http://127.0.0.1:8188/");
		expect(prevented).toBe(true);
		expect(h.newTab).toHaveBeenCalledWith("http://127.0.0.1:8188/");
		expect(h.toggleFeeds).toHaveBeenCalledTimes(1);
		expect(h.switchTab).toHaveBeenCalledWith("browser");
	});

	it("right rail already open → not toggled shut again", () => {
		const h = loadSharedDom({ feedsOpen: true });
		dispatch(h, "http://127.0.0.1:8188/");
		expect(h.toggleFeeds).not.toHaveBeenCalled();
		expect(h.switchTab).toHaveBeenCalledWith("browser");
	});

	it("external links keep their default (system browser) path", () => {
		const h = loadSharedDom();
		const prevented = dispatch(h, "https://example.com/");
		expect(prevented).toBe(false);
		expect(h.newTab).not.toHaveBeenCalled();
	});

	it("LAX-origin links keep their default path", () => {
		const h = loadSharedDom();
		expect(dispatch(h, `${APP_ORIGIN}/account.html`)).toBe(false);
		expect(h.newTab).not.toHaveBeenCalled();
	});

	it("file-download links stay owned by the file handler, never the browser", () => {
		const h = loadSharedDom();
		dispatch(h, `${APP_ORIGIN}/files/report.md`, ["md-link", "file-download"]);
		expect(h.newTab).not.toHaveBeenCalled();
	});

	it("plain browser (no desktop bridge) stands down — target=_blank works there", () => {
		const h = loadSharedDom({ desktop: null });
		const prevented = dispatch(h, "http://127.0.0.1:8188/");
		expect(prevented).toBe(false);
	});
});
