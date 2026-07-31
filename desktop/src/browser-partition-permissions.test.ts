/**
 * browser-partition-permissions — the human-consent layer. The prompt is
 * injected, so these run with no Electron dialog and no real Session.
 */
import { describe, expect, it, vi } from "vitest";
import type { Session } from "electron";
import {
	installPermissionHandlers,
	permissionOrigin,
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
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledWith("https://from-wc.example", "media"));
	});
});
