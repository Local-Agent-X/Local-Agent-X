/**
 * browser-partition-permissions — the human-consent layer. The prompt is
 * injected, so these run with no Electron dialog and no real Session.
 */
import { describe, expect, it, vi } from "vitest";
import type { Session } from "electron";

// The release gate runs these without the electron package installed; the
// prompt is injected, so the dialog is never shown.
vi.mock("electron", () => ({ dialog: { showMessageBox: vi.fn() } }));

import {
	allowPermission,
	describePermissionRequest,
	installPermissionHandlers,
	permissionOrigin,
	QUIET_BLOCKED_PERMISSIONS,
	setQuietBlockSink,
	SILENT_DENIED_PERMISSIONS,
	SILENT_SAFE_PERMISSIONS,
} from "./browser-partition-permissions";

type CheckHandler = (wc: unknown, permission: string, origin: string, details: { requestingUrl?: string }) => boolean;
type RequestHandler = (
	wc: unknown,
	permission: string,
	callback: (granted: boolean) => void,
	details: { requestingUrl?: string },
) => void;

/** Captures the two handlers the module installs. */
function fakeSession() {
	const captured: { check?: CheckHandler; request?: RequestHandler } = {};
	const sess = {
		setPermissionCheckHandler: (fn: CheckHandler) => { captured.check = fn; },
		setPermissionRequestHandler: (fn: RequestHandler) => { captured.request = fn; },
	} as unknown as Session;
	return { sess, captured };
}

const PAGE = { requestingUrl: "https://site.example/app" };

describe("permissionOrigin", () => {
	it("reduces a URL to its origin and never throws on garbage", () => {
		expect(permissionOrigin("https://site.example/a/b?c=1")).toBe("https://site.example");
		expect(permissionOrigin("not a url")).toBe("unknown-origin");
		expect(permissionOrigin("")).toBe("unknown-origin");
	});
});

describe("silent decisions (no modal)", () => {
	it("grants clipboard writes and denies passive/noisy capabilities without prompting", () => {
		const { sess, captured } = fakeSession();
		const prompt = vi.fn(async () => true);
		installPermissionHandlers(sess, prompt);

		const answers: boolean[] = [];
		captured.request!(null, "clipboard-sanitized-write", (g) => answers.push(g), PAGE);
		for (const denied of SILENT_DENIED_PERMISSIONS) {
			captured.request!(null, denied, (g) => answers.push(g), PAGE);
		}
		expect(answers[0]).toBe(true);
		expect(answers.slice(1).every((a) => a === false)).toBe(true);
		expect(prompt).not.toHaveBeenCalled(); // the whole point: no interruption
	});

	it("the check handler mirrors those verdicts without consulting memory", () => {
		const { sess, captured } = fakeSession();
		installPermissionHandlers(sess, vi.fn(async () => true));
		expect(captured.check!(null, [...SILENT_SAFE_PERMISSIONS][0], "https://site.example", PAGE)).toBe(true);
		expect(captured.check!(null, "notifications", "https://site.example", PAGE)).toBe(false);
	});
});

describe("prompted decisions", () => {
	it("asks the human once, then remembers the answer for that origin+permission", async () => {
		const { sess, captured } = fakeSession();
		const prompt = vi.fn(async () => true);
		installPermissionHandlers(sess, prompt);

		const first: boolean[] = [];
		captured.request!(null, "media", (g) => first.push(g), PAGE);
		await vi.waitFor(() => expect(first).toEqual([true]));

		const second: boolean[] = [];
		captured.request!(null, "media", (g) => second.push(g), PAGE);
		expect(second).toEqual([true]);
		expect(prompt).toHaveBeenCalledTimes(1); // remembered, not re-asked
		// A remembered grant is also visible to the check handler.
		expect(captured.check!(null, "media", "https://site.example", PAGE)).toBe(true);
	});

	it("COALESCES simultaneous requests: one modal, every caller settled", async () => {
		const { sess, captured } = fakeSession();
		let release!: (granted: boolean) => void;
		const prompt = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));
		installPermissionHandlers(sess, prompt);

		const answers: boolean[] = [];
		captured.request!(null, "geolocation", (g) => answers.push(g), PAGE);
		captured.request!(null, "geolocation", (g) => answers.push(g), PAGE);
		captured.request!(null, "geolocation", (g) => answers.push(g), PAGE);
		expect(prompt).toHaveBeenCalledTimes(1); // three asks, ONE dialog
		expect(answers).toEqual([]); // nobody settles before the human answers

		release(false);
		await vi.waitFor(() => expect(answers).toEqual([false, false, false]));
	});

	it("keeps decisions separate per origin and per permission", async () => {
		const { sess, captured } = fakeSession();
		const prompt = vi.fn(async (origin: string) => origin === "https://trusted.example");
		installPermissionHandlers(sess, prompt);

		const out: Record<string, boolean> = {};
		captured.request!(null, "media", (g) => { out.trusted = g; }, { requestingUrl: "https://trusted.example/x" });
		captured.request!(null, "media", (g) => { out.other = g; }, { requestingUrl: "https://other.example/x" });
		await vi.waitFor(() => expect(Object.keys(out)).toHaveLength(2));
		expect(out).toEqual({ trusted: true, other: false });

		// A grant for `media` must not leak to a different permission.
		expect(captured.check!(null, "geolocation", "https://trusted.example", { requestingUrl: "https://trusted.example/x" })).toBe(false);
	});

	it("a denial is remembered too — the page cannot re-prompt its way to a grant", async () => {
		const { sess, captured } = fakeSession();
		const prompt = vi.fn(async () => false);
		installPermissionHandlers(sess, prompt);

		const answers: boolean[] = [];
		captured.request!(null, "media", (g) => answers.push(g), PAGE);
		await vi.waitFor(() => expect(answers).toEqual([false]));
		captured.request!(null, "media", (g) => answers.push(g), PAGE);
		expect(answers).toEqual([false, false]);
		expect(prompt).toHaveBeenCalledTimes(1);
	});

	it("falls back to the webContents URL when details carry no requestingUrl", async () => {
		const { sess, captured } = fakeSession();
		const prompt = vi.fn(async () => true);
		installPermissionHandlers(sess, prompt);
		const wc = { isDestroyed: () => false, getURL: () => "https://from-wc.example/page" };
		captured.request!(wc, "media", () => {}, {});
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledWith(
			"https://from-wc.example", "media", expect.objectContaining({ requestingUrl: "https://from-wc.example/page" }),
		));
	});
});

// Live 2026-11-19: "https://lpcdn-vip.lpsnmedia.net wants permission to use
// storage-access." A raw permission name and an embedded widget's CDN domain,
// in a modal, over microsoft.com. The words must say who asks, on which page,
// and what it could do.
describe("describePermissionRequest — the request in plain words", () => {
	it("names the page when an embedded piece of it is the one asking", () => {
		const { who, what } = describePermissionRequest({
			permission: "storage-access",
			requestingUrl: "https://lpcdn-vip.lpsnmedia.net/le_unified_window/index.html",
			pageUrl: "https://www.microsoft.com/en-us/microsoft-365/onedrive",
		});
		expect(who).toBe("Something embedded in microsoft.com (from lpcdn-vip.lpsnmedia.net)");
		expect(what).toContain("remember you");
		expect(what).not.toContain("storage-access");
	});

	it("names just the site when the page itself asks", () => {
		const { who } = describePermissionRequest({
			permission: "geolocation", requestingUrl: "https://maps.example/x", pageUrl: "https://maps.example/",
		});
		expect(who).toBe("maps.example");
	});

	it("says camera or microphone from what the request names", () => {
		const ask = { permission: "media", requestingUrl: "https://meet.example/", pageUrl: "https://meet.example/" };
		expect(describePermissionRequest({ ...ask, mediaTypes: ["video"] }).what).toBe("use your camera");
		expect(describePermissionRequest({ ...ask, mediaTypes: ["audio"] }).what).toBe("use your microphone");
		expect(describePermissionRequest(ask).what).toBe("use your camera and microphone");
	});

	it("falls back to the raw name, labelled, only for a permission it does not know", () => {
		const { what } = describePermissionRequest({ permission: "brand-new-thing", requestingUrl: "https://a.example/", pageUrl: "" });
		expect(what).toBe('use a browser feature called "brand-new-thing"');
	});
});

describe("quiet blocks — storage access from a pane tab gets a bar, not a modal", () => {
	const TAB = { isDestroyed: () => false, getURL: () => "https://www.microsoft.com/onedrive" };
	const WIDGET = { requestingUrl: "https://lpcdn.lpsnmedia.net/chat" };

	it("blocks without a modal and hands the pane the plain sentence", () => {
		const { sess, captured } = fakeSession();
		const prompt = vi.fn(async () => true);
		const shown: unknown[] = [];
		setQuietBlockSink((_wc, block) => { shown.push(block); return true; });
		try {
			installPermissionHandlers(sess, prompt);
			for (const permission of QUIET_BLOCKED_PERMISSIONS) {
				const answers: boolean[] = [];
				captured.request!(TAB, permission, (g) => answers.push(g), WIDGET);
				expect(answers).toEqual([false]);
			}
			expect(prompt).not.toHaveBeenCalled();
			expect(shown[0]).toEqual({
				origin: "https://lpcdn.lpsnmedia.net",
				permission: "storage-access",
				text: expect.stringMatching(/^Something embedded in microsoft\.com \(from lpcdn\.lpsnmedia\.net\) wanted to remember you/),
			});
		} finally {
			setQuietBlockSink(null);
		}
	});

	it("does NOT remember the block, so the bar's Allow can still grant it", () => {
		const { sess, captured } = fakeSession();
		setQuietBlockSink(() => true);
		try {
			installPermissionHandlers(sess, vi.fn(async () => true));
			captured.request!(TAB, "storage-access", () => {}, WIDGET);
			allowPermission(sess, "https://lpcdn.lpsnmedia.net", "storage-access");
			const answers: boolean[] = [];
			captured.request!(TAB, "storage-access", (g) => answers.push(g), WIDGET);
			expect(answers).toEqual([true]);
			expect(captured.check!(TAB, "storage-access", "https://lpcdn.lpsnmedia.net", WIDGET)).toBe(true);
		} finally {
			setQuietBlockSink(null);
		}
	});

	it("falls back to the modal when no pane tab can show it (a popup, or a sink that throws)", async () => {
		for (const sink of [() => false, () => { throw new Error("pane gone"); }]) {
			const { sess, captured } = fakeSession();
			const prompt = vi.fn(async () => false);
			setQuietBlockSink(sink);
			try {
				installPermissionHandlers(sess, prompt);
				const answers: boolean[] = [];
				captured.request!(TAB, "storage-access", (g) => answers.push(g), WIDGET);
				await vi.waitFor(() => expect(answers).toEqual([false]));
				expect(prompt).toHaveBeenCalledTimes(1);
			} finally {
				setQuietBlockSink(null);
			}
		}
	});

	it("never quietly blocks a meaningful permission: the camera still asks", async () => {
		const { sess, captured } = fakeSession();
		const prompt = vi.fn(async () => true);
		const sink = vi.fn(() => true);
		setQuietBlockSink(sink);
		try {
			installPermissionHandlers(sess, prompt);
			captured.request!(TAB, "media", () => {}, PAGE);
			await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
			expect(sink).not.toHaveBeenCalled();
		} finally {
			setQuietBlockSink(null);
		}
	});
});
