// F1: a CDP BrowserManager launches its shared Chrome under the session's
// PROFILE userDataDir — not the shared chrome-profile — so the CDP twin of a
// profile holds its own logins. Here we prove the first hop: getPage() passes
// profileUserDataDir(profileId) as the 4th arg to acquireSessionContext. We stop
// the flow with a sentinel throw right after that call so no real Chrome or
// context machinery runs.
import { describe, it, expect, vi, beforeEach } from "vitest";

const runtimeMock = vi.hoisted(() => ({
	acquireSessionContext: vi.fn(async () => { throw new Error("STOP-AFTER-ACQUIRE"); }),
	releaseSessionContext: vi.fn(async () => undefined),
}));

vi.mock("./runtime.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./runtime.js")>();
	return { ...original, ...runtimeMock };
});

import { BrowserManager } from "./manager.js";
import { profileUserDataDir, DEFAULT_PROFILE_ID } from "./profile-store.js";

beforeEach(() => vi.clearAllMocks());

describe("BrowserManager.getPage — profile userDataDir threading", () => {
	it("launches a non-default profile under its own browser-profiles/<id> dir", async () => {
		const mgr = new BrowserManager("agent-run", "isolated", "work");
		await expect(mgr.getPage()).rejects.toThrow("STOP-AFTER-ACQUIRE");
		expect(runtimeMock.acquireSessionContext).toHaveBeenCalledWith(
			"chromium",
			"isolated",
			"agent-run",
			profileUserDataDir("work"),
		);
	});

	it("launches the default profile under the legacy shared dir (alias)", async () => {
		const mgr = new BrowserManager("chat-1"); // profileId defaults to "default"
		await expect(mgr.getPage()).rejects.toThrow("STOP-AFTER-ACQUIRE");
		expect(runtimeMock.acquireSessionContext).toHaveBeenCalledWith(
			"chromium",
			"isolated",
			"chat-1",
			profileUserDataDir(DEFAULT_PROFILE_ID),
		);
	});

	it("carries the profile dir on the continuity mode too", async () => {
		const mgr = new BrowserManager("cron-nightly", "continuity", "work");
		await expect(mgr.getPage()).rejects.toThrow("STOP-AFTER-ACQUIRE");
		expect(runtimeMock.acquireSessionContext).toHaveBeenCalledWith(
			"chromium",
			"continuity",
			"cron-nightly",
			profileUserDataDir("work"),
		);
	});
});
