import { afterEach, describe, expect, it, vi } from "vitest";

// Keep this file hermetic: bridge-perception routes download pushes into
// downloads.ts (config/fs machinery) — the routing law is what's under test.
vi.mock("./downloads.js", () => ({ ingestInAppDownload: vi.fn(async () => null) }));

import { EventBus } from "../event-bus.js";
import {
	formatConsoleReport,
	formatNetworkReport,
	handleAgentViewClosed,
	handleBrowserDownloadEvent,
	handleBrowserUiEvent,
	sessionIdFromViewId,
	setAgentViewClosedHandler,
} from "./bridge-perception.js";
import { ingestInAppDownload } from "./downloads.js";
import { sanitizeUiEvent } from "../orchestrator/ui-event-store.js";

afterEach(() => {
	EventBus.removeAllListeners("ui:browser");
});

describe("sessionIdFromViewId", () => {
	it("parses the sessionId out of agent viewIds, including hyphenated sessions and -tN tabs", () => {
		expect(sessionIdFromViewId("view-sess-1-work")).toBe("sess-1");
		expect(sessionIdFromViewId("view-sess-1-work-t2")).toBe("sess-1");
		expect(sessionIdFromViewId("view-abc-default")).toBe("abc");
	});

	it("returns undefined for user views and malformed ids (global scope by design)", () => {
		expect(sessionIdFromViewId("foreground")).toBeUndefined();
		expect(sessionIdFromViewId("user-3")).toBeUndefined();
		expect(sessionIdFromViewId("profile-work")).toBeUndefined();
		expect(sessionIdFromViewId("view-x")).toBeUndefined(); // no profile segment
		expect(sessionIdFromViewId(42)).toBeUndefined();
		expect(sessionIdFromViewId(undefined)).toBeUndefined();
	});
});

describe("handleAgentViewClosed → registered handler", () => {
	afterEach(() => setAgentViewClosedHandler(null));

	it("dispatches the viewId to the registered handler", () => {
		const seen: string[] = [];
		setAgentViewClosedHandler((viewId) => seen.push(viewId));
		handleAgentViewClosed({ viewId: "view-sess-1-work" });
		expect(seen).toEqual(["view-sess-1-work"]);
	});

	it("ignores missing/empty/non-string viewIds and a missing handler", () => {
		const seen: string[] = [];
		setAgentViewClosedHandler((viewId) => seen.push(viewId));
		handleAgentViewClosed({});
		handleAgentViewClosed({ viewId: "" });
		handleAgentViewClosed({ viewId: 42 });
		expect(seen).toEqual([]);
		setAgentViewClosedHandler(null);
		expect(() => handleAgentViewClosed({ viewId: "view-sess-1-work" })).not.toThrow();
	});
});

describe("handleBrowserUiEvent → ui:browser bus", () => {
	function capture(): Array<Record<string, unknown>> {
		const received: Array<Record<string, unknown>> = [];
		EventBus.on("ui:browser", (data) => { received.push(data as Record<string, unknown>); });
		return received;
	}

	it("emits a store-valid event with the sessionId parsed from the viewId", () => {
		const received = capture();
		handleBrowserUiEvent({
			type: "lax:browser-ui-event", surface: "browser", action: "navigate",
			target: "https://example.com/inbox", viewId: "view-sess-9-work-t2", ts: 1234,
		});
		expect(received).toEqual([
			{ surface: "browser", action: "navigate", target: "https://example.com/inbox", sessionId: "sess-9", ts: 1234 },
		]);
		// The store's schema law accepts it (label-shaped action, no smuggling).
		expect(sanitizeUiEvent(received[0])).not.toBeNull();
	});

	it("omits sessionId for user views (global scope)", () => {
		const received = capture();
		handleBrowserUiEvent({ action: "tab-open", viewId: "foreground", ts: 99 });
		expect(received).toEqual([{ surface: "browser", action: "tab-open", ts: 99 }]);
		expect("sessionId" in received[0]).toBe(false);
	});

	it("stamps the surface itself and drops malformed input", () => {
		const received = capture();
		handleBrowserUiEvent({ surface: "evil=1", action: "title", target: "Hi", viewId: "user-1", ts: 5 });
		expect(received[0].surface).toBe("browser"); // wire surface never trusted
		handleBrowserUiEvent({ target: "no action", viewId: "user-1", ts: 5 }); // no action → dropped
		handleBrowserUiEvent({ action: "  ", viewId: "user-1", ts: 5 });        // blank action → dropped
		expect(received.length).toBe(1);
		// Non-string / bogus fields degrade, never throw.
		handleBrowserUiEvent({ action: "title", target: 42, viewId: null, ts: "soon" });
		expect(received[1]).toMatchObject({ surface: "browser", action: "title" });
		expect("target" in received[1]).toBe(false);
		expect(typeof received[1].ts).toBe("number");
	});
});

describe("handleBrowserDownloadEvent → canonical download ingest", () => {
	const download = {
		id: "desk-1", url: "https://files.test/a.pdf", pageUrl: "https://files.test/",
		filename: "a.pdf", mime: "application/pdf", bytes: 10, state: "completed",
		savePath: "C:/tmp/desk-1.part",
	};

	afterEach(() => vi.clearAllMocks());

	it("routes an agent view's download to ingest under the session parsed from the viewId", () => {
		handleBrowserDownloadEvent({ type: "lax:browser-download-event", viewId: "view-sess-7-work-t2", download });
		expect(ingestInAppDownload).toHaveBeenCalledTimes(1);
		expect(vi.mocked(ingestInAppDownload).mock.calls[0][0]).toBe("sess-7");
		expect(vi.mocked(ingestInAppDownload).mock.calls[0][1]).toEqual(download);
	});

	it("skips user views and unattributed (null) viewIds — never a global-scope record", () => {
		handleBrowserDownloadEvent({ viewId: "foreground", download });
		handleBrowserDownloadEvent({ viewId: null, download });
		handleBrowserDownloadEvent({ viewId: "user-3", download });
		expect(ingestInAppDownload).not.toHaveBeenCalled();
	});

	it("an ADOPTED user view's download follows the takeover into the adopting session (skeptic regression)", async () => {
		const { registerAdoptedView, unregisterAdoptedViews, _resetAdoptedViewsForTest } = await import("./bridge-perception.js");
		_resetAdoptedViewsForTest();
		// Un-adopted: skipped (previous test's rule still holds).
		handleBrowserDownloadEvent({ viewId: "foreground", download });
		expect(ingestInAppDownload).not.toHaveBeenCalled();
		// Adopted by sess-9: the same event now attributes to that session.
		registerAdoptedView("foreground", "sess-9");
		handleBrowserDownloadEvent({ viewId: "foreground", download });
		expect(ingestInAppDownload).toHaveBeenCalledTimes(1);
		expect(vi.mocked(ingestInAppDownload).mock.calls[0][0]).toBe("sess-9");
		// Session close drops the adoption — back to skipped.
		unregisterAdoptedViews("sess-9");
		handleBrowserDownloadEvent({ viewId: "foreground", download });
		expect(ingestInAppDownload).toHaveBeenCalledTimes(1);
		_resetAdoptedViewsForTest();
	});

	it("drops malformed payloads (missing download / id / savePath / state) without throwing", () => {
		handleBrowserDownloadEvent({ viewId: "view-s-1-work" });
		handleBrowserDownloadEvent({ viewId: "view-s-1-work", download: { ...download, id: 5 } });
		handleBrowserDownloadEvent({ viewId: "view-s-1-work", download: { ...download, savePath: undefined } });
		handleBrowserDownloadEvent({ viewId: "view-s-1-work", download: { ...download, state: 9 } });
		expect(ingestInAppDownload).not.toHaveBeenCalled();
	});

	it("degrades non-string metadata to safe defaults instead of dropping the entry", () => {
		handleBrowserDownloadEvent({
			viewId: "view-s-1-work",
			download: { id: "desk-2", savePath: "C:/tmp/d2.part", state: "completed", url: 1, pageUrl: null, filename: {}, mime: 4, bytes: "big" },
		});
		expect(vi.mocked(ingestInAppDownload).mock.calls[0][1]).toEqual({
			id: "desk-2", savePath: "C:/tmp/d2.part", state: "completed",
			url: "", pageUrl: "", filename: "download.bin", mime: "", bytes: 0,
		});
	});
});

describe("formatConsoleReport", () => {
	it("reports the empty state honestly", () => {
		expect(formatConsoleReport([])).toBe("No console messages captured for this tab.");
	});

	it("leads with counts + levels and lists entries newest last", () => {
		const out = formatConsoleReport([
			{ level: "info", message: "booting", ts: 1 },
			{ level: "warning", message: "slow asset", ts: 2 },
			{ level: "error", message: "TypeError: x is not a function", ts: 3 },
		]);
		const lines = out.split("\n");
		expect(lines[0]).toBe("Console: 3 message(s) (1 error(s), 1 warning(s)), newest last:");
		expect(lines[3]).toBe("[error] TypeError: x is not a function"); // newest last
	});
});

describe("formatNetworkReport", () => {
	it("reports the empty state with the in-flight count", () => {
		expect(formatNetworkReport([], 2)).toBe("No network requests captured for this tab. 2 request(s) in flight");
	});

	it("prints status or error per line plus failure count and in-flight tail", () => {
		const out = formatNetworkReport(
			[
				{ url: "https://api.example/ok", method: "GET", status: 200, ts: 1 },
				{ url: "https://api.example/missing", method: "GET", status: 404, ts: 2 },
				{ url: "https://api.example/dead", method: "POST", error: "net::ERR_CONNECTION_REFUSED", ts: 3 },
			],
			1,
		);
		const lines = out.split("\n");
		expect(lines[0]).toBe("Network: 3 request(s) captured (2 failed/error status), newest last:");
		expect(lines[1]).toBe("GET 200 https://api.example/ok");
		expect(lines[2]).toBe("GET 404 https://api.example/missing");
		expect(lines[3]).toBe("POST FAILED (net::ERR_CONNECTION_REFUSED) https://api.example/dead");
		expect(lines[4]).toBe("1 request(s) in flight");
	});
});
