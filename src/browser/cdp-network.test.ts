import { afterEach, describe, expect, it } from "vitest";
import { readResponseBody, _setPageProviderForTest } from "./cdp-network.js";

// Fakes standing in for Playwright's Page / CDPSession / APIResponse — no real
// socket. The session records its responseReceived listener so a test can
// simulate a CDP event (populating the metadata map) and then read the buffered
// body via getResponseBody; the re-fetch tests leave the map empty.

type Listener = (payload: unknown) => void;

function fakeSession(getBody: { body: string; base64Encoded: boolean }) {
	const listeners = new Map<string, Listener>();
	return {
		session: {
			send: async (method: string, _params?: unknown) => {
				if (method === "Network.getResponseBody") return getBody;
				return {};
			},
			on: (event: string, listener: Listener) => { listeners.set(event, listener); },
		},
		// Simulate a Network.responseReceived firing on the live page.
		emit: (event: string, payload: unknown) => listeners.get(event)?.(payload),
	};
}

function fakeResponse(contentType: string, text: string) {
	return {
		headers: () => ({ "content-type": contentType }),
		text: async () => text,
	};
}

function fakePage(session: unknown, getImpl: (url: string) => unknown) {
	return {
		context: () => ({ newCDPSession: async () => session }),
		request: { get: async (url: string) => getImpl(url) },
	};
}

afterEach(() => {
	_setPageProviderForTest(null);
});

describe("readResponseBody", () => {
	it("returns a buffered JSON body via Network.getResponseBody (no re-fetch label)", async () => {
		const json = '{"ok":true}';
		const s = fakeSession({ body: json, base64Encoded: false });
		const page = fakePage(s.session, () => fakeResponse("application/json", json));
		_setPageProviderForTest(async () => page as never);

		// First read attaches the sniffer (metadata map still empty → re-fetch).
		const first = await readResponseBody("view-1", "https://x/api");
		expect(first).toContain("[re-fetched");

		// A later response for the same url arrives → sniffer records its requestId.
		s.emit("Network.responseReceived", {
			requestId: "req-1",
			type: "XHR",
			response: { url: "https://x/api", mimeType: "application/json" },
		});

		// Second read now serves the buffered body directly — no re-fetch label.
		const second = await readResponseBody("view-1", "https://x/api");
		expect(second).toBe(json);
	});

	it("truncates a body over the cap in memory (no file written)", async () => {
		const big = "a".repeat(100_001);
		const s = fakeSession({ body: "", base64Encoded: false }); // force re-fetch
		const page = fakePage(s.session, () => fakeResponse("application/json", big));
		_setPageProviderForTest(async () => page as never);

		const out = await readResponseBody("view-1", "https://x/api");
		expect(out).toContain("[truncated — body exceeded 100000 chars]");
		// The kept body is exactly MAX_CHARS chars — returned inline, not a path.
		expect(out).toContain("a".repeat(100_000));
		expect(out).not.toContain("a".repeat(100_001));
	});

	it("refuses a non-data content-type via isDataEndpoint", async () => {
		const s = fakeSession({ body: "PNGDATA", base64Encoded: false });
		const page = fakePage(s.session, () => fakeResponse("image/png", "PNGDATA"));
		_setPageProviderForTest(async () => page as never);

		const out = await readResponseBody("view-1", "https://x/logo.png");
		expect(out).toContain("image/png");
		expect(out).toContain("not a data endpoint");
		expect(out).not.toContain("PNGDATA");
	});

	it("returns a not-available message when there is no CDP page", async () => {
		_setPageProviderForTest(async () => null);
		const out = await readResponseBody("view-1", "https://x/api");
		expect(out).toContain("not available");
	});

	it("falls back to a labeled re-fetch when nothing is buffered", async () => {
		const json = '{"data":[1,2,3]}';
		const s = fakeSession({ body: "", base64Encoded: false });
		const page = fakePage(s.session, () => fakeResponse("application/json", json));
		_setPageProviderForTest(async () => page as never);

		const out = await readResponseBody("view-1", "https://x/api");
		expect(out).toContain("[re-fetched");
		expect(out).toContain(json);
	});
});

// ── Shared-state ownership audit (C2, 2026-09-10) ───────────────────────
// `sniffers` is keyed by viewId and has NO production invalidator: only
// _setPageProviderForTest clears it. viewIds are deterministic per session
// (`view-<session>-shared`, `<first>-tN`) and a view is RECREATED under the SAME
// id on ordinary paths (wedge teardown, user ✕ on the tab — see
// in-app-tabs.ensureTabView). getPageForView then resolves a BRAND-NEW Page, but
// this module still serves the dead view's CDPSession and metadata.
//
// Contrast — the reader asymmetry that makes this a defect rather than a design:
// in-app-driving-page.ts caches by the SAME recycled key and gates every hit on
// page.isClosed() ("self-heals a recreated view"). This module has no liveness
// gate at all.
//
// These pin the CURRENT behavior so a fix flips them deliberately rather than by
// accident. Parked as finding H2; no behavior is changed here.
describe("readResponseBody — H2: a recycled viewId is served the previous view's sniffer", () => {
	const viewId = "view-chat-shared";
	const json = '{"ok":true}';

	/** A fresh in-app view under the same viewId: its own CDPSession + page. */
	function recreatedView(session: unknown, counter: { attached: number }, contentType = "application/json") {
		return {
			context: () => ({ newCDPSession: async () => { counter.attached += 1; return session; } }),
			request: { get: async () => fakeResponse(contentType, json) },
		};
	}

	it("never attaches a sniffer to the recreated view — the dead CDPSession is reused", async () => {
		const counter = { attached: 0 };
		const s1 = fakeSession({ body: json, base64Encoded: false });
		let current: unknown = recreatedView(s1.session, counter);
		_setPageProviderForTest(async () => current as never);

		await readResponseBody(viewId, "https://x/api");
		expect(counter.attached).toBe(1);

		// View destroyed and recreated under the SAME id → a different Page object.
		const s2 = fakeSession({ body: json, base64Encoded: false });
		current = recreatedView(s2.session, counter);
		await readResponseBody(viewId, "https://x/api");

		// A liveness-gated cache would attach to the new page. This one does not.
		expect(counter.attached).toBe(1);
	});

	it("refuses a now-JSON endpoint using the DEAD view's stale content-type metadata", async () => {
		const counter = { attached: 0 };
		// Page 1 served an image at this url, so the sniffer records image/png.
		const s1 = fakeSession({ body: "PNGDATA", base64Encoded: false });
		let current: unknown = recreatedView(s1.session, counter, "image/png");
		_setPageProviderForTest(async () => current as never);
		await readResponseBody(viewId, "https://x/api");
		s1.emit("Network.responseReceived", {
			requestId: "req-old",
			type: "Image",
			response: { url: "https://x/api", mimeType: "image/png" },
		});

		// The view is recreated; the same url now serves JSON on the new page.
		const s2 = fakeSession({ body: json, base64Encoded: false });
		current = recreatedView(s2.session, counter);
		const out = await readResponseBody(viewId, "https://x/api");

		// The live page is never consulted: the stale meta wins and the read is
		// refused on the PREVIOUS page's content-type.
		expect(out).toContain("is not a data endpoint");
		expect(out).toContain("image/png");
		expect(out).not.toContain(json);
	});
});
