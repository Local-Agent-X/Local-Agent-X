// F1: a CDP BrowserManager launches its shared Chrome under the session's
// PROFILE userDataDir — not the shared chrome-profile — so the CDP twin of a
// profile holds its own logins. Here we prove the first hop: getPage() passes
// shared userDataDir as the 4th arg to acquireSessionContext. We stop
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
import { SHARED_BROWSER_USER_DATA_DIR } from "./launcher.js";

beforeEach(() => vi.clearAllMocks());

describe("BrowserManager.getPage — profile userDataDir threading", () => {
	it("launches an agent session under the shared browser identity", async () => {
		const mgr = new BrowserManager("agent-run", "isolated");
		await expect(mgr.getPage()).rejects.toThrow("STOP-AFTER-ACQUIRE");
		expect(runtimeMock.acquireSessionContext).toHaveBeenCalledWith(
			"chromium",
			"isolated",
			"agent-run",
			SHARED_BROWSER_USER_DATA_DIR,
		);
	});

	it("launches the default profile under the legacy shared dir (alias)", async () => {
		const mgr = new BrowserManager("chat-1");
		await expect(mgr.getPage()).rejects.toThrow("STOP-AFTER-ACQUIRE");
		expect(runtimeMock.acquireSessionContext).toHaveBeenCalledWith(
			"chromium",
			"isolated",
			"chat-1",
			SHARED_BROWSER_USER_DATA_DIR,
		);
	});

	it("carries the shared identity into continuity mode", async () => {
		const mgr = new BrowserManager("cron-nightly", "continuity");
		await expect(mgr.getPage()).rejects.toThrow("STOP-AFTER-ACQUIRE");
		expect(runtimeMock.acquireSessionContext).toHaveBeenCalledWith(
			"chromium",
			"continuity",
			"cron-nightly",
			SHARED_BROWSER_USER_DATA_DIR,
		);
	});
});
