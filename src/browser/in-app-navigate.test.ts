/** navigateInAppView leaf: native-vs-bridge selection + driver-agnostic egress
 *  enrichment, with the bridge client mocked and a fake real Page injected. */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./bridge-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./bridge-client.js")>();
	return { ...actual, browserNavigate: vi.fn() };
});

import { browserNavigate } from "./bridge-client.js";
import { navigateInAppView } from "./in-app-navigate.js";
import { _setPageResolverForTest } from "./in-app-driving-page.js";
import * as bridgeEgress from "./bridge-egress.js";

const VIEW_ID = "view-sess-1-work";
const PAGE_URL = "https://example.com/";
const PAGE_TITLE = "Example Domain";
const VAULT_URL = "https://vault.bitwarden.com/passwords";

/** A fake real Page — only the members gotoPage/realDrivingPage touch:
 *  isClosed (liveness), goto/url (nav read), title (read on the native path). */
function fakeRealPage(opts: { url: string; status?: number; title?: string; gotoRejects?: Error }) {
	return {
		isClosed: () => false,
		goto: vi.fn(async () => {
			if (opts.gotoRejects) throw opts.gotoRejects;
			return opts.status !== undefined ? { status: () => opts.status } : null;
		}),
		url: () => opts.url,
		title: vi.fn(async () => opts.title ?? "Native Title"),
	};
}

afterEach(() => {
	_setPageResolverForTest(null); // restore the default resolver + clear the cache
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe("navigateInAppView", () => {
	it("native: drives page.goto, reads the title off the real Page, and skips the bridge", async () => {
		const real = fakeRealPage({ url: PAGE_URL, status: 200, title: PAGE_TITLE });
		_setPageResolverForTest(async () => real as never);

		const res = await navigateInAppView(VIEW_ID, PAGE_URL, "sess-1");

		expect(real.goto).toHaveBeenCalledWith(PAGE_URL, expect.objectContaining({ waitUntil: "domcontentloaded" }));
		expect(real.title).toHaveBeenCalled();
		expect(browserNavigate).not.toHaveBeenCalled();
		expect(res).toEqual({ url: PAGE_URL, title: PAGE_TITLE, status: 200 });
	});

	it("native: withholds — never fetches — the title of a sensitive landed URL", async () => {
		const real = fakeRealPage({ url: VAULT_URL, status: 200 });
		_setPageResolverForTest(async () => real as never);

		const res = await navigateInAppView(VIEW_ID, VAULT_URL, "sess-1");

		expect(real.title).not.toHaveBeenCalled();
		expect(res).toEqual({ url: VAULT_URL, title: "", status: 200 });
	});

	it("native: omits status for a non-HTTP load (no Response)", async () => {
		const real = fakeRealPage({ url: PAGE_URL, title: PAGE_TITLE }); // goto → null
		_setPageResolverForTest(async () => real as never);

		const res = await navigateInAppView(VIEW_ID, PAGE_URL, "sess-1");

		expect(res).toEqual({ url: PAGE_URL, title: PAGE_TITLE });
		expect("status" in res).toBe(false);
	});

	it("EGRESS: a native goto blocked by the guard is re-thrown ENRICHED, not the raw error", async () => {
		const real = fakeRealPage({
			url: PAGE_URL,
			gotoRejects: new Error("page.goto: net::ERR_BLOCKED_BY_CLIENT at " + PAGE_URL),
		});
		_setPageResolverForTest(async () => real as never);
		// Prime the recent-deny cache (as the egress answerer would) so the shared
		// enrichBlockedNavigation has a policy reason to surface for this view+url.
		bridgeEgress.recordEgressDeny(PAGE_URL, VIEW_ID, "SSRF: loopback host denied", "use http_request instead");
		const enrich = vi.spyOn(bridgeEgress, "enrichBlockedNavigation");

		const err = await navigateInAppView(VIEW_ID, PAGE_URL, "sess-1").then(
			() => { throw new Error("navigateInAppView should have rejected"); },
			(e: Error) => e,
		);

		expect(enrich).toHaveBeenCalledWith(expect.any(Error), PAGE_URL, VIEW_ID);
		expect(err.message).toContain("blocked by the egress policy: SSRF: loopback host denied");
		expect(err.message).toContain("Recovery: use http_request instead");
		expect(err.message).not.toContain("ERR_BLOCKED_BY_CLIENT");
		expect(real.title).not.toHaveBeenCalled(); // the throw preempts the title read
		expect(browserNavigate).not.toHaveBeenCalled();
	});

	it("FALLBACK: no real Page → the bridge browserNavigate drives, unchanged", async () => {
		_setPageResolverForTest(async () => null);
		vi.mocked(browserNavigate).mockResolvedValue({ url: PAGE_URL, title: PAGE_TITLE });

		const res = await navigateInAppView(VIEW_ID, PAGE_URL, "sess-1");

		expect(browserNavigate).toHaveBeenCalledWith(VIEW_ID, PAGE_URL, "sess-1");
		expect(res).toEqual({ url: PAGE_URL, title: PAGE_TITLE });
	});

	it("FALLBACK: a bridge navigation blocked by the guard is ENRICHED identically", async () => {
		_setPageResolverForTest(async () => null);
		vi.mocked(browserNavigate).mockRejectedValue(new Error("ERR_BLOCKED_BY_CLIENT"));
		bridgeEgress.recordEgressDeny(PAGE_URL, VIEW_ID, "denied by policy");
		const enrich = vi.spyOn(bridgeEgress, "enrichBlockedNavigation");

		const err = await navigateInAppView(VIEW_ID, PAGE_URL, "sess-1").then(
			() => { throw new Error("navigateInAppView should have rejected"); },
			(e: Error) => e,
		);

		expect(enrich).toHaveBeenCalledWith(expect.any(Error), PAGE_URL, VIEW_ID);
		expect(err.message).toContain("blocked by the egress policy: denied by policy");
	});
});
