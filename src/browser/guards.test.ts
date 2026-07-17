import { beforeEach, describe, expect, it, vi } from "vitest";
import { installRequestGuard, scanEvaluateScript } from "./guards.js";
import { buildAgentCsp } from "./csp-policy.js";

// The guard registers its handler via context.route(); we capture that handler
// and drive it with fake route/request objects, exactly as manager.test.ts
// does for the SSRF/scheme cases. Here we focus on the response-side CSP
// injection: a top-level document navigation must be fetched+fulfilled with our
// agent CSP APPENDED, while every non-document request stays on continue().

interface FakeRoute {
	abort: ReturnType<typeof vi.fn>;
	continue: ReturnType<typeof vi.fn>;
	fetch: ReturnType<typeof vi.fn>;
	fulfill: ReturnType<typeof vi.fn>;
}

function fakeResponse(headers: Record<string, string>) {
	return { headers: () => headers };
}

function fakeRoute(upstreamHeaders: Record<string, string> = {}): FakeRoute {
	// A bare fakeRoute() models a normal HTML document response so the CSP-inject
	// path (which now skips non-HTML/attachment responses) engages by default.
	const response = fakeResponse({ "content-type": "text/html; charset=utf-8", ...upstreamHeaders });
	return {
		abort: vi.fn().mockResolvedValue(undefined),
		continue: vi.fn().mockResolvedValue(undefined),
		fetch: vi.fn().mockResolvedValue(response),
		fulfill: vi.fn().mockResolvedValue(undefined),
	};
}

function fakeRequest(
	url: string,
	opts: { resourceType?: string; navigation?: boolean; parentFrame?: unknown } = {},
) {
	// A main-frame document has NO parent frame; an iframe document has one.
	// Default parentFrame === null so unspecified requests model the main frame.
	const parentFrame = opts.parentFrame ?? null;
	return {
		url: () => url,
		resourceType: () => opts.resourceType ?? "document",
		isNavigationRequest: () => opts.navigation ?? true,
		frame: () => ({ parentFrame: () => parentFrame }),
	};
}

type RouteHandler = (route: FakeRoute, request: ReturnType<typeof fakeRequest>) => Promise<void>;

async function captureGuard(): Promise<RouteHandler> {
	let handler: RouteHandler | undefined;
	// Brand-new context object each call so the install-once WeakSet never
	// short-circuits between tests.
	const fakeContext = {
		route: vi.fn(async (_pattern: string, h: RouteHandler) => { handler = h; }),
	};
	await installRequestGuard(fakeContext as unknown as Parameters<typeof installRequestGuard>[0]);
	if (!handler) throw new Error("guard did not register a route handler");
	return handler;
}

// Literal public IP is validated synchronously by the canonical egress gate, so
// these tests stay deterministic offline (no DNS for a hostname).
const PUBLIC_DOC_URL = "http://93.184.216.34/";

describe("installRequestGuard — document CSP injection (CDP/Playwright backend)", () => {
	beforeEach(() => { vi.clearAllMocks(); });

	it("fulfills a top-level document with our agent CSP appended as an additional header", async () => {
		const handler = await captureGuard();
		const route = fakeRoute();
		await handler(route, fakeRequest(PUBLIC_DOC_URL));

		expect(route.fetch).toHaveBeenCalledTimes(1);
		expect(route.fulfill).toHaveBeenCalledTimes(1);
		// Never continue()/abort() the document once we take the fulfill path.
		expect(route.continue).not.toHaveBeenCalled();
		expect(route.abort).not.toHaveBeenCalled();

		const arg = route.fulfill.mock.calls[0][0];
		expect(arg.headers["content-security-policy"]).toBe(buildAgentCsp(PUBLIC_DOC_URL));
	});

	it("APPENDS (never replaces) a site's own Content-Security-Policy, and preserves other headers", async () => {
		const siteCsp = "default-src 'self' https://cdn.site.example";
		const handler = await captureGuard();
		const route = fakeRoute({
			"content-security-policy": siteCsp,
			"content-type": "text/html; charset=utf-8",
			"x-frame-options": "DENY",
		});
		await handler(route, fakeRequest(PUBLIC_DOC_URL));

		const arg = route.fulfill.mock.calls[0][0];
		// Comma-joined: the site's policy is still present AND ours is appended.
		expect(arg.headers["content-security-policy"]).toBe(`${siteCsp}, ${buildAgentCsp(PUBLIC_DOC_URL)}`);
		// Unrelated upstream headers survive verbatim.
		expect(arg.headers["content-type"]).toBe("text/html; charset=utf-8");
		expect(arg.headers["x-frame-options"]).toBe("DENY");
		// The upstream response is handed back to fulfill for the body.
		expect(arg.response).toBeDefined();
	});

	it("does NOT fetch+fulfill a non-document sub-resource — stays on continue() (no perf/behavior regression)", async () => {
		const handler = await captureGuard();
		const route = fakeRoute();
		await handler(route, fakeRequest("http://93.184.216.34/app.js", { resourceType: "script", navigation: false }));

		expect(route.continue).toHaveBeenCalledTimes(1);
		expect(route.fetch).not.toHaveBeenCalled();
		expect(route.fulfill).not.toHaveBeenCalled();
		expect(route.abort).not.toHaveBeenCalled();
	});

	it("does NOT fetch+fulfill a document-typed sub-resource that is not a navigation (e.g. iframe doc refetch stays cheap)", async () => {
		const handler = await captureGuard();
		const route = fakeRoute();
		await handler(route, fakeRequest("http://93.184.216.34/frame", { resourceType: "document", navigation: false }));

		expect(route.continue).toHaveBeenCalledTimes(1);
		expect(route.fetch).not.toHaveBeenCalled();
		expect(route.fulfill).not.toHaveBeenCalled();
	});

	// REGRESSION (iframe misclassification). An iframe's INITIAL load is
	// resourceType:"document" AND isNavigationRequest:true — identical to the
	// top-level document on those two predicates. The ONLY distinguisher is that
	// an iframe's frame has a parent. If we fetch+fulfill it, buildAgentCsp stamps
	// `frame-ancestors 'none'` and Chromium refuses to embed the frame (breaks
	// Stripe/OAuth/map/video widgets). This test FAILS against the pre-fix
	// predicate (which took the fetch+fulfill path for any document navigation).
	it("does NOT fetch+fulfill an iframe INITIAL navigation (document + navigation, but has a parent frame) — never stamps frame-ancestors on an embedded frame", async () => {
		const handler = await captureGuard();
		const route = fakeRoute();
		await handler(route, fakeRequest("http://93.184.216.34/embed", {
			resourceType: "document",
			navigation: true,
			parentFrame: { name: "top" }, // truthy parent => this is an iframe, not the main frame
		}));

		expect(route.continue).toHaveBeenCalledTimes(1);
		expect(route.fetch).not.toHaveBeenCalled();
		expect(route.fulfill).not.toHaveBeenCalled();
		expect(route.abort).not.toHaveBeenCalled();
	});

	it("injects CSP on a MAIN-frame document (no parent frame, content-type text/html)", async () => {
		const handler = await captureGuard();
		const route = fakeRoute();
		await handler(route, fakeRequest(PUBLIC_DOC_URL, {
			resourceType: "document",
			navigation: true,
			parentFrame: null, // main frame
		}));

		expect(route.fetch).toHaveBeenCalledTimes(1);
		expect(route.fulfill).toHaveBeenCalledTimes(1);
		expect(route.continue).not.toHaveBeenCalled();
		const arg = route.fulfill.mock.calls[0][0];
		expect(arg.headers["content-security-policy"]).toBe(buildAgentCsp(PUBLIC_DOC_URL));
	});

	it("applies CSP to the FINAL document of a redirect chain (route.fetch follows redirects internally)", async () => {
		const handler = await captureGuard();
		// route.fetch() resolves the redirect chain internally and returns the
		// final 200 document; from the handler's view it is one HTML response.
		const route = fakeRoute({ "content-type": "text/html; charset=utf-8" });
		route.fetch.mockResolvedValue({
			status: () => 200,
			headers: () => ({ "content-type": "text/html; charset=utf-8" }),
		});
		await handler(route, fakeRequest(PUBLIC_DOC_URL));

		expect(route.fetch).toHaveBeenCalledTimes(1);
		expect(route.fulfill).toHaveBeenCalledTimes(1);
		const arg = route.fulfill.mock.calls[0][0];
		expect(arg.headers["content-security-policy"]).toBe(buildAgentCsp(PUBLIC_DOC_URL));
	});

	it("preserves an upstream Set-Cookie header through the fulfill (multi-cookie \\n-folded value passes verbatim)", async () => {
		const setCookie = "a=1; Path=/; HttpOnly\nb=2; Path=/; Secure";
		const handler = await captureGuard();
		const route = fakeRoute({
			"content-type": "text/html; charset=utf-8",
			"set-cookie": setCookie,
		});
		await handler(route, fakeRequest(PUBLIC_DOC_URL));

		const arg = route.fulfill.mock.calls[0][0];
		expect(arg.headers["set-cookie"]).toBe(setCookie);
		// CSP still injected alongside the preserved cookie.
		expect(arg.headers["content-security-policy"]).toBe(buildAgentCsp(PUBLIC_DOC_URL));
	});

	it("does NOT inject CSP on a main-frame navigation whose response is an attachment download (fulfilled through unchanged, no re-issue)", async () => {
		const handler = await captureGuard();
		const route = fakeRoute({
			"content-type": "application/octet-stream",
			"content-disposition": "attachment; filename=\"report.pdf\"",
		});
		await handler(route, fakeRequest(PUBLIC_DOC_URL));

		// The already-fetched response is fulfilled through (so Chromium's own
		// download machinery handles it); a second continue() would re-issue and
		// could double-submit a POST navigation.
		expect(route.fetch).toHaveBeenCalledTimes(1);
		expect(route.fulfill).toHaveBeenCalledTimes(1);
		expect(route.continue).not.toHaveBeenCalled();
		const arg = route.fulfill.mock.calls[0][0];
		expect(arg.headers).toBeUndefined(); // fulfilled with { response } only — no header rewrite
	});

	it("does NOT inject CSP on a main-frame navigation whose response is a non-HTML content type", async () => {
		const handler = await captureGuard();
		const route = fakeRoute({ "content-type": "application/json" });
		await handler(route, fakeRequest(PUBLIC_DOC_URL));

		expect(route.fetch).toHaveBeenCalledTimes(1);
		expect(route.fulfill).toHaveBeenCalledTimes(1);
		const arg = route.fulfill.mock.calls[0][0];
		expect(arg.headers).toBeUndefined();
	});

	it("still ABORTS an SSRF/blocked document navigation before any fetch+fulfill (egress gate preserved)", async () => {
		const handler = await captureGuard();
		const route = fakeRoute();
		await handler(route, fakeRequest("http://169.254.169.254/latest/meta-data/"));

		expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
		expect(route.fetch).not.toHaveBeenCalled();
		expect(route.fulfill).not.toHaveBeenCalled();
		expect(route.continue).not.toHaveBeenCalled();
	});
});

describe("scanEvaluateScript — evaluate() blocklist (CSP owns egress; this owns read-leak + dynamic-exec + WebRTC)", () => {
	// --- The Function false-positive fix (the composer-injector class) ---------
	// The `Function` constructor pattern is now case-SENSITIVE, so the benign
	// lowercase `function` keyword no longer trips it. This unblocks every legit
	// function declaration / expression / IIFE inside an evaluate script.
	it("does NOT block a benign IIFE `(function(){})()`", () => {
		expect(scanEvaluateScript("(function(){})()")).toBeNull();
	});
	it("does NOT block a benign function declaration", () => {
		expect(scanEvaluateScript("function foo(){ return 1 }")).toBeNull();
	});
	// The real `Function` constructor (always capital-F) is still blocked.
	it("STILL blocks `new Function(...)`", () => {
		expect(scanEvaluateScript('new Function("x","return x")')).not.toBeNull();
	});
	it("STILL blocks `Function(...)()` invoked-constructor form", () => {
		expect(scanEvaluateScript('Function("alert(1)")()')).not.toBeNull();
	});

	// --- Read-into-model-context leaks: STILL blocked (CSP irrelevant) ---------
	// A script can read a secret and RETURN it to the model with zero network
	// egress, so CSP cannot cover these — the read itself must stay blocked.
	it.each([
		["document.cookie", "return document.cookie"],
		["localStorage", 'localStorage.getItem("token")'],
		["sessionStorage", "return sessionStorage.length"],
		["indexedDB", "indexedDB.open('x')"],
		["password field selector", 'document.querySelector("[type=password]").value'],
	])("STILL blocks read-leak: %s", (_label, script) => {
		expect(scanEvaluateScript(script)).not.toBeNull();
	});

	// --- Egress primitives: NOW allowed by the scanner ------------------------
	// These are enforced BY CONSTRUCTION by the per-document agent CSP on BOTH
	// backends (csp-policy.ts / desktop/src/browser-csp.ts: connect-src /
	// img-src / form-action / script-src / worker-src). CSP — not this regex —
	// is the egress enforcement layer for them, so the scanner returns null.
	it.each([
		["fetch", 'fetch("https://x")'],
		["XMLHttpRequest", "new XMLHttpRequest()"],
		["WebSocket", 'new WebSocket("wss://x")'],
		["sendBeacon", 'navigator.sendBeacon("/x", d)'],
		["element .src assignment", 'el.src = "https://x/track.gif"'],
		["createElement", 'document.createElement("script")'],
		["form.submit", "form.submit()"],
	])("does NOT block egress primitive (CSP owns it): %s", (_label, script) => {
		expect(scanEvaluateScript(script)).toBeNull();
	});

	// --- WebRTC: STILL blocked (known CSP connect-src bypass) ------------------
	it("STILL blocks `new RTCPeerConnection()` (WebRTC data channels bypass CSP)", () => {
		expect(scanEvaluateScript("new RTCPeerConnection()")).not.toBeNull();
	});

	// --- Dynamic code execution + workers: STILL blocked ----------------------
	it.each([
		["eval", 'eval("1+1")'],
		["dynamic import", 'import("https://x/m.js")'],
		["Worker", 'new Worker("w.js")'],
	])("STILL blocks dynamic-exec/worker: %s", (_label, script) => {
		expect(scanEvaluateScript(script)).not.toBeNull();
	});
});
