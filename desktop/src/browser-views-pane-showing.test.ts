// Nothing paints a web page over a closed panel. With the panel closed the
// renderer had said "hidden" once, and a tab switch (the renderer surfaces an
// agent's new page even then) attached the view anyway, at whatever size the
// pane last reported; hide only ever detached "the current view", which a
// retarget could leave different from the one on screen (2026-11-25).
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ children: [] as unknown[] }));

vi.mock("electron", () => {
	class WebContentsView {
		bounds: unknown = null;
		webContents = {
			id: Math.floor(Math.random() * 1e9),
			loadURL: () => Promise.resolve(),
			executeJavaScript: () => Promise.resolve(),
			isDestroyed: () => false,
			close: () => {},
			getURL: () => "about:blank",
			getTitle: () => "",
		};
		setBounds(b: unknown) { this.bounds = b; }
		setVisible() {}
	}
	return { WebContentsView };
});
vi.mock("./window", () => ({
	getMainWindow: () => ({
		isDestroyed: () => false,
		contentView: {
			get children() { return h.children; },
			addChildView: (v: unknown) => { h.children.push(v); },
			removeChildView: (v: unknown) => { h.children = h.children.filter((c) => c !== v); },
		},
	}),
}));
vi.mock("./browser-chat-overlay", () => ({ applyChatOverlay: () => {}, attachChatOverlay: () => {}, detachChatOverlay: () => {} }));
vi.mock("./browser-partition", () => ({ getHardenedPartitionSession: () => ({}), setViewTrustResolver: () => {}, viewWebPreferences: () => ({}) }));
vi.mock("./browser-download-routing", () => ({ viewTrust: () => true }));
vi.mock("./browser-view-popups", () => ({ managePopups: () => ({ closeAll: () => {} }) }));
vi.mock("./in-app-browser", () => ({ armCoDrive: () => {} }));
vi.mock("./browser-offstage-host", () => ({ OFFSTAGE_SIZE: { width: 1, height: 1 }, parkView: () => {}, resizeParkedView: () => {}, unparkView: () => {} }));

import {
	closeBrowserView,
	createBrowserView,
	getAttachedViewId,
	hideAttachedBrowserView,
	listBrowserViews,
	showBrowserView,
	showBrowserViewIfPaneShowing,
} from "./browser-views";

const RECT = { x: 900, y: 150, width: 1000, height: 800 };

beforeEach(() => {
	hideAttachedBrowserView();
	for (const v of listBrowserViews()) closeBrowserView(v.viewId);
	h.children = [];
	createBrowserView("home", { partition: "p", bounds: RECT });
	createBrowserView("view-chat-agent", { partition: "p", bounds: RECT, agentDriven: true });
});

describe("a retarget never attaches a view the pane did not ask for", () => {
	it("with the pane closed, switching to an agent's page puts nothing on screen", () => {
		expect(showBrowserViewIfPaneShowing("view-chat-agent")).toBe(false);
		expect(getAttachedViewId()).toBeNull();
		expect(h.children).toHaveLength(0);
	});

	it("with the pane showing, the switch replaces the view on screen", () => {
		showBrowserView("home");
		expect(showBrowserViewIfPaneShowing("view-chat-agent")).toBe(true);
		expect(getAttachedViewId()).toBe("view-chat-agent");
		expect(h.children).toHaveLength(1);
	});
});

describe("hiding the pane", () => {
	it("takes off whichever view is on screen", () => {
		showBrowserView("home");
		showBrowserViewIfPaneShowing("view-chat-agent");
		hideAttachedBrowserView();
		expect(getAttachedViewId()).toBeNull();
		expect(h.children).toHaveLength(0);
	});

	it("is a no-op with nothing on screen", () => {
		hideAttachedBrowserView();
		expect(h.children).toHaveLength(0);
	});
});
