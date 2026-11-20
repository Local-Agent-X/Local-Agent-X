// The permission bar's main side: a quiet block reaches the pane tagged with
// its tab, and the bar's Allow can grant only what the bar blocked.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	sent: [] as unknown[][],
	viewIdByWc: new Map<number, string>(),
	views: [] as Array<{ viewId: string; partition: string }>,
	reloads: [] as string[],
	grants: [] as unknown[][],
	sink: null as null | ((wc: unknown, block: unknown) => boolean),
}));

vi.mock("electron", () => ({
	ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { h.handlers.set(channel, fn); } },
}));
vi.mock("./window", () => ({
	getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...args: unknown[]) => { h.sent.push(args); } } }),
}));
vi.mock("./browser-page-controls", () => ({
	isTrustedBrowserSender: (sender: { trusted?: boolean }) => sender.trusted === true,
}));
vi.mock("./browser-partition", () => ({
	getHardenedPartitionSession: (partition: string) => ({ partition }),
}));
vi.mock("./browser-views", () => ({
	viewIdForWebContents: (id: number) => h.viewIdByWc.get(id) ?? null,
	listBrowserViews: () => h.views,
	getBrowserView: (viewId: string) => (h.views.some((v) => v.viewId === viewId)
		? { webContents: { isDestroyed: () => false, reload: () => { h.reloads.push(viewId); } } }
		: undefined),
}));
vi.mock("./browser-partition-permissions", () => ({
	QUIET_BLOCKED_PERMISSIONS: new Set(["storage-access", "top-level-storage-access"]),
	allowPermission: (...args: unknown[]) => { h.grants.push(args); },
	setQuietBlockSink: (fn: typeof h.sink) => { h.sink = fn; },
}));

import { setupBrowserPermissionBarIPC } from "./browser-permission-bar-ipc";

const BLOCK = { origin: "https://lpcdn.lpsnmedia.net", permission: "storage-access", text: "Something … wanted to remember you." };
const TRUSTED = { sender: { trusted: true } };

beforeEach(() => {
	h.handlers.clear();
	h.sent = [];
	h.reloads = [];
	h.grants = [];
	h.viewIdByWc = new Map([[11, "user-1"]]);
	h.views = [{ viewId: "user-1", partition: "persist:lax-profile-v2" }];
	setupBrowserPermissionBarIPC();
});

describe("a quiet block reaches the pane", () => {
	it("is pushed tagged with the tab it happened in", () => {
		expect(h.sink!({ id: 11 }, BLOCK)).toBe(true);
		expect(h.sent).toEqual([["browser-permission-blocked", { viewId: "user-1", ...BLOCK }]]);
	});

	it("is refused for a webContents that is no pane tab, so the modal asks instead", () => {
		expect(h.sink!({ id: 99 }, BLOCK)).toBe(false);
		expect(h.sent).toEqual([]);
	});
});

describe("the bar's Allow", () => {
	const allow = (...args: unknown[]) => h.handlers.get("browser-permission-allow")!(...args);

	it("grants that origin+permission on the tab's partition, then reloads the tab", () => {
		expect(allow(TRUSTED, "user-1", BLOCK.origin, "storage-access")).toBe(true);
		expect(h.grants).toEqual([[{ partition: "persist:lax-profile-v2" }, BLOCK.origin, "storage-access"]]);
		expect(h.reloads).toEqual(["user-1"]);
	});

	it("cannot grant anything the bar did not block — the camera keeps its modal", () => {
		expect(allow(TRUSTED, "user-1", BLOCK.origin, "media")).toBe(false);
		expect(h.grants).toEqual([]);
	});

	it("is refused for an untrusted sender and for a tab that no longer exists", () => {
		expect(allow({ sender: {} }, "user-1", BLOCK.origin, "storage-access")).toBe(false);
		expect(allow(TRUSTED, "user-9", BLOCK.origin, "storage-access")).toBe(false);
		expect(h.grants).toEqual([]);
		expect(h.reloads).toEqual([]);
	});
});
