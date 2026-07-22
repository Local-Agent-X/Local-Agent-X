import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const evaluateEgressForUrl = vi.fn<(url: string, selfPort?: string) => { allowed: boolean; reason: string }>();

vi.mock("../security/layer/index.js", () => ({
	evaluateEgressForUrl: (url: string, selfPort?: string) => evaluateEgressForUrl(url, selfPort),
}));
vi.mock("../config.js", () => ({
	getRuntimeConfig: () => ({ port: 7007 }),
}));
// Don't spawn the real off-loop egress worker from these unit tests (it is
// exercised end-to-end in egress-worker.test.ts) — capture the start call.
const startEgressWorkerHost = vi.fn<(onEndpoint: (pipeName: string) => void) => void>();
vi.mock("./egress-worker-host.js", () => ({
	startEgressWorkerHost: (onEndpoint: (pipeName: string) => void) => startEgressWorkerHost(onEndpoint),
}));

import {
	BridgeOpError,
	BridgeTimeoutError,
	BridgeUnavailableError,
	BridgeViewClosedError,
	browserAbort,
	browserCapture,
	browserExec,
	browserInput,
	browserLifecycle,
	browserNavigate,
	browserReadConsole,
	browserReadNetwork,
	initBrowserBridgeClient,
	INPUT_TIMEOUT_MS,
	LIFECYCLE_TIMEOUT_MS,
	NAVIGATE_DESKTOP_TIMEOUT_MS,
} from "./bridge-client.js";
import { EventBus } from "../event-bus.js";
import { recordSensitiveRead, clearSessionTaint } from "../data-lineage/index.js";

const originalSend = process.send;
const originalEnv = process.env.LAX_DESKTOP_BRIDGE;
const sendMock = vi.fn<(msg: unknown) => boolean>();

interface SentMessage { type: string; id?: number; [key: string]: unknown }

function sent(): SentMessage[] {
	return sendMock.mock.calls.map(([msg]) => msg as SentMessage);
}

function lastSent(): SentMessage {
	const all = sent();
	expect(all.length).toBeGreaterThan(0);
	return all[all.length - 1];
}

function receive(msg: Record<string, unknown>): void {
	// The strict Process overload demands a SendHandle; the raw EventEmitter
	// surface is what the listener actually sees for IPC messages.
	(process as unknown as { emit(event: string, ...args: unknown[]): boolean }).emit("message", msg);
}

beforeEach(() => {
	sendMock.mockReset().mockReturnValue(true);
	evaluateEgressForUrl.mockReset();
	startEgressWorkerHost.mockReset();
	process.env.LAX_DESKTOP_BRIDGE = "1";
	// eslint-disable-next-line @typescript-eslint/unbound-method
	process.send = sendMock as unknown as typeof process.send;
});

afterEach(() => {
	vi.useRealTimers();
	process.send = originalSend;
	if (originalEnv === undefined) delete process.env.LAX_DESKTOP_BRIDGE;
	else process.env.LAX_DESKTOP_BRIDGE = originalEnv;
});

describe("browser bridge client — happy paths", () => {
	it("lifecycle create sends the partition and resolves the view info", async () => {
		const p = browserLifecycle("create", "v1", { partition: "persist:lax-profile-abc", bounds: { x: 0, y: 0, width: 800, height: 600 } });
		const msg = lastSent();
		expect(msg).toMatchObject({ type: "lax:browser-lifecycle", op: "create", viewId: "v1", partition: "persist:lax-profile-abc" });
		const view = { viewId: "v1", partition: "persist:lax-profile-abc", url: "", title: "", attached: false };
		receive({ type: "lax:browser-lifecycle-result", id: msg.id, ok: true, view });
		await expect(p).resolves.toEqual({ view, views: undefined, ping: undefined });
	});

	it("lifecycle create without a partition rejects before sending", async () => {
		await expect(browserLifecycle("create", "v1")).rejects.toBeInstanceOf(BridgeOpError);
		expect(sent().filter((m) => m.type === "lax:browser-lifecycle")).toHaveLength(0);
	});

	it("navigate carries the desktop deadline and resolves url + title", async () => {
		const p = browserNavigate("v1", "https://example.com/");
		const msg = lastSent();
		expect(msg).toMatchObject({ type: "lax:browser-navigate", viewId: "v1", url: "https://example.com/", timeoutMs: NAVIGATE_DESKTOP_TIMEOUT_MS });
		receive({ type: "lax:browser-navigate-result", id: msg.id, ok: true, url: "https://example.com/", title: "Example" });
		await expect(p).resolves.toEqual({ url: "https://example.com/", title: "Example" });
	});

	it("navigate passes the desktop's real HTTP status through when present", async () => {
		const p = browserNavigate("v1", "https://example.com/missing");
		receive({ type: "lax:browser-navigate-result", id: lastSent().id, ok: true, url: "https://example.com/missing", title: "404", status: 404 });
		await expect(p).resolves.toEqual({ url: "https://example.com/missing", title: "404", status: 404 });
	});

	it("read-console correlates and resolves the entries array (garbage → empty)", async () => {
		const p = browserReadConsole("v1");
		const msg = lastSent();
		expect(msg).toMatchObject({ type: "lax:browser-read-console", viewId: "v1" });
		const entries = [{ level: "error", message: "boom", ts: 5 }];
		receive({ type: "lax:browser-read-console-result", id: msg.id, ok: true, entries });
		await expect(p).resolves.toEqual(entries);

		const p2 = browserReadConsole("v1");
		receive({ type: "lax:browser-read-console-result", id: lastSent().id, ok: true, entries: "nope" });
		await expect(p2).resolves.toEqual([]);
	});

	it("read-network correlates and resolves entries + inFlight (missing → safe defaults)", async () => {
		const p = browserReadNetwork("v1");
		const msg = lastSent();
		expect(msg).toMatchObject({ type: "lax:browser-read-network", viewId: "v1" });
		const network = { entries: [{ url: "https://x/", method: "GET", status: 500, ts: 9 }], inFlight: 2 };
		receive({ type: "lax:browser-read-network-result", id: msg.id, ok: true, network });
		await expect(p).resolves.toEqual(network);

		const p2 = browserReadNetwork("v1");
		receive({ type: "lax:browser-read-network-result", id: lastSent().id, ok: true });
		await expect(p2).resolves.toEqual({ entries: [], inFlight: 0 });
	});

	it("read ops reject typed on ok:false and time out on the LIFECYCLE class", async () => {
		const p = browserReadConsole("v9");
		receive({ type: "lax:browser-read-console-result", id: lastSent().id, ok: false, error: 'no browser view "v9"' });
		await expect(p).rejects.toThrow('browser read-console failed (viewId=v9): no browser view "v9"');

		vi.useFakeTimers();
		const p2 = browserReadNetwork("v9");
		const expectation = expect(p2).rejects.toThrow(`browser read-network timed out after ${LIFECYCLE_TIMEOUT_MS}ms (viewId=v9)`);
		vi.advanceTimersByTime(LIFECYCLE_TIMEOUT_MS);
		await expectation;
	});

	it("exec defaults to the isolated world and returns the result", async () => {
		const p = browserExec("v1", "1 + 1");
		const msg = lastSent();
		expect(msg).toMatchObject({ type: "lax:browser-exec", viewId: "v1", script: "1 + 1", world: "isolated" });
		receive({ type: "lax:browser-exec-result", id: msg.id, ok: true, result: 2 });
		await expect(p).resolves.toBe(2);
	});

	it("input sends the typed event and resolves on ok", async () => {
		const p = browserInput("v1", { type: "mouseDown", x: 10, y: 20, button: "left", clickCount: 1 });
		const msg = lastSent();
		expect(msg).toMatchObject({ type: "lax:browser-input", viewId: "v1", event: { type: "mouseDown", x: 10, y: 20 } });
		receive({ type: "lax:browser-input-result", id: msg.id, ok: true });
		await expect(p).resolves.toBeUndefined();
	});

	it("capture resolves the base64 PNG and rejects an empty payload", async () => {
		const p = browserCapture("v1");
		const msg = lastSent();
		expect(msg).toMatchObject({ type: "lax:browser-capture", viewId: "v1" });
		receive({ type: "lax:browser-capture-result", id: msg.id, ok: true, pngB64: "aGk=" });
		await expect(p).resolves.toBe("aGk=");

		const p2 = browserCapture("v1");
		receive({ type: "lax:browser-capture-result", id: lastSent().id, ok: true });
		await expect(p2).rejects.toBeInstanceOf(BridgeOpError);
	});

	it("an ok:false reply rejects with the desktop's error", async () => {
		const p = browserExec("v9", "document.title");
		receive({ type: "lax:browser-exec-result", id: lastSent().id, ok: false, error: 'no browser view "v9"' });
		await expect(p).rejects.toThrow('browser exec failed (viewId=v9): no browser view "v9"');
	});
});

describe("browser bridge client — failure modes", () => {
	it("rejects with BridgeTimeoutError naming op and viewId when no reply lands", async () => {
		vi.useFakeTimers();
		const p = browserInput("v2", { type: "keyDown", keyCode: "a" });
		const expectation = expect(p).rejects.toThrow(`browser input timed out after ${INPUT_TIMEOUT_MS}ms (viewId=v2)`);
		vi.advanceTimersByTime(INPUT_TIMEOUT_MS);
		await expectation;
		await expect(p).rejects.toBeInstanceOf(BridgeTimeoutError);
	});

	it("rejects with BridgeUnavailableError outside the desktop", async () => {
		delete process.env.LAX_DESKTOP_BRIDGE;
		await expect(browserExec("v1", "1")).rejects.toBeInstanceOf(BridgeUnavailableError);
		expect(sent()).toHaveLength(0);
	});

	it("close rejects pending ops for that view but not other views", async () => {
		const doomed = browserNavigate("v3", "https://example.com/");
		const doomedId = lastSent().id;
		const bystander = browserExec("v4", "1");
		const bystanderId = lastSent().id;

		const close = browserLifecycle("close", "v3");
		const closeId = lastSent().id;

		await expect(doomed).rejects.toBeInstanceOf(BridgeViewClosedError);
		await expect(doomed).rejects.toThrow('view "v3" was closed');

		receive({ type: "lax:browser-lifecycle-result", id: closeId, ok: true });
		await expect(close).resolves.toEqual({ view: undefined, views: undefined, ping: undefined });

		receive({ type: "lax:browser-exec-result", id: bystanderId, ok: true, result: 1 });
		await expect(bystander).resolves.toBe(1);
		expect(bystanderId).not.toBe(doomedId);
	});
});

describe("browser bridge client — abort", () => {
	it("abort is fire-and-forget: no id, no pending entry", () => {
		browserAbort("v5");
		expect(lastSent()).toEqual({ type: "lax:browser-abort", viewId: "v5" });
		expect(lastSent().id).toBeUndefined();
	});

	it("abort is a silent no-op when the bridge is absent", () => {
		delete process.env.LAX_DESKTOP_BRIDGE;
		expect(() => browserAbort("v5")).not.toThrow();
		expect(sent()).toHaveLength(0);
	});

	it("abort swallows a send failure instead of throwing", () => {
		sendMock.mockImplementation(() => { throw new Error("channel closed"); });
		expect(() => browserAbort("v5")).not.toThrow();
	});
});

describe("browser bridge client — reverse egress-ask channel", () => {
	it("answers an egress ask from the canonical policy", () => {
		initBrowserBridgeClient();
		evaluateEgressForUrl.mockReturnValue({ allowed: true, reason: "allowlisted" });
		receive({ type: "lax:browser-egress-ask", id: 991, url: "https://allowed.example/" });
		expect(evaluateEgressForUrl).toHaveBeenCalledWith("https://allowed.example/", expect.any(String));
		expect(sent()).toContainEqual({ type: "lax:browser-egress-ask-result", id: 991, allowed: true });
	});

	it("answers allowed:false when the policy denies", () => {
		initBrowserBridgeClient();
		evaluateEgressForUrl.mockReturnValue({ allowed: false, reason: "blocked" });
		receive({ type: "lax:browser-egress-ask", id: 992, url: "http://169.254.169.254/" });
		expect(sent()).toContainEqual({ type: "lax:browser-egress-ask-result", id: 992, allowed: false });
	});

	it("fails closed when the evaluator throws", () => {
		initBrowserBridgeClient();
		evaluateEgressForUrl.mockImplementation(() => { throw new Error("policy exploded"); });
		receive({ type: "lax:browser-egress-ask", id: 993, url: "https://x.example/" });
		expect(sent()).toContainEqual({ type: "lax:browser-egress-ask-result", id: 993, allowed: false });
	});

	it("ignores a malformed ask instead of replying", () => {
		initBrowserBridgeClient();
		receive({ type: "lax:browser-egress-ask", url: "https://x.example/" }); // no id
		expect(sent().filter((m) => m.type === "lax:browser-egress-ask-result")).toHaveLength(0);
	});

	it("starts the off-loop egress worker host and announces each endpoint to the desktop", () => {
		initBrowserBridgeClient();
		expect(startEgressWorkerHost).toHaveBeenCalledTimes(1);
		const onEndpoint = startEgressWorkerHost.mock.calls[0][0];
		onEndpoint("\\\\.\\pipe\\lax-egress-1-aa");
		onEndpoint("\\\\.\\pipe\\lax-egress-1-bb"); // worker restarted → NEW name re-announced
		expect(sent()).toEqual([
			{ type: "lax:browser-egress-endpoint", pipeName: "\\\\.\\pipe\\lax-egress-1-aa" },
			{ type: "lax:browser-egress-endpoint", pipeName: "\\\\.\\pipe\\lax-egress-1-bb" },
		]);
	});

	it("does not start the egress worker host off-desktop", () => {
		delete process.env.LAX_DESKTOP_BRIDGE;
		initBrowserBridgeClient();
		expect(startEgressWorkerHost).not.toHaveBeenCalled();
	});
});

describe("browser bridge client — taint-aware page-egress scan", () => {
	const SID = "peg-bridge-sess";
	const VIEW = `view-${SID}-default`; // sessionIdFromViewId(VIEW) === SID
	// >= SHINGLE_WIDTH so it fingerprints; distinctive so overlap is unambiguous.
	const SECRET = "aws_secret_access_key_9f8e7d6c5b4a3210ffeeddccbbaa";

	afterEach(() => clearSessionTaint(SID));

	it("BLOCKS a URL-policy-allowed cross-domain request carrying tainted bytes (agent view)", () => {
		initBrowserBridgeClient();
		evaluateEgressForUrl.mockReturnValue({ allowed: true, reason: "public host ok" });
		recordSensitiveRead(SID, "secret", "vault:aws", SECRET);
		receive({ type: "lax:browser-egress-ask", id: 701, url: `https://evil.com/x?d=${SECRET}`, pageUrl: "https://myapp.com/", viewId: VIEW });
		// URL policy said allow, but the taint gate overrides it → deny.
		expect(sent()).toContainEqual({ type: "lax:browser-egress-ask-result", id: 701, allowed: false });
	});

	it("ALLOWS a cross-domain CDN read on the same tainted session (rendering survives)", () => {
		initBrowserBridgeClient();
		evaluateEgressForUrl.mockReturnValue({ allowed: true, reason: "public host ok" });
		recordSensitiveRead(SID, "secret", "vault:aws", SECRET);
		receive({ type: "lax:browser-egress-ask", id: 702, url: "https://abs.twimg.com/main.abc.js", pageUrl: "https://x.com/", viewId: VIEW });
		expect(sent()).toContainEqual({ type: "lax:browser-egress-ask-result", id: 702, allowed: true });
	});

	it("does NOT block a tainted payload when the view is unattributable (URL policy only)", () => {
		initBrowserBridgeClient();
		evaluateEgressForUrl.mockReturnValue({ allowed: true, reason: "ok" });
		recordSensitiveRead(SID, "secret", "vault:aws", SECRET);
		// No viewId → no session attribution → the taint scan is skipped by design.
		receive({ type: "lax:browser-egress-ask", id: 703, url: `https://evil.com/x?d=${SECRET}` });
		expect(sent()).toContainEqual({ type: "lax:browser-egress-ask-result", id: 703, allowed: true });
	});

	it("still denies when the URL policy denies, regardless of the scan", () => {
		initBrowserBridgeClient();
		evaluateEgressForUrl.mockReturnValue({ allowed: false, reason: "SSRF" });
		receive({ type: "lax:browser-egress-ask", id: 704, url: "http://169.254.169.254/", pageUrl: "https://x.com/", viewId: VIEW });
		expect(sent()).toContainEqual({ type: "lax:browser-egress-ask-result", id: 704, allowed: false });
	});
});

describe("browser bridge client — inbound UI events (desktop co-drive activity)", () => {
	afterEach(() => {
		EventBus.removeAllListeners("ui:browser");
	});

	it("lax:browser-ui-event lands on the ui:browser bus with the sessionId parsed from the viewId", () => {
		initBrowserBridgeClient();
		const received: Array<Record<string, unknown>> = [];
		EventBus.on("ui:browser", (data) => { received.push(data as Record<string, unknown>); });
		receive({ type: "lax:browser-ui-event", surface: "browser", action: "navigate", target: "https://x.example/a", viewId: "view-sess-4-work-t2", ts: 777 });
		receive({ type: "lax:browser-ui-event", action: "tab-open", viewId: "foreground", ts: 778 });
		expect(received).toEqual([
			{ surface: "browser", action: "navigate", target: "https://x.example/a", sessionId: "sess-4", ts: 777 },
			{ surface: "browser", action: "tab-open", ts: 778 },
		]);
		expect("sessionId" in received[1]).toBe(false); // user view → global scope
		// Fire-and-forget: nothing was sent back to the desktop.
		expect(sent()).toHaveLength(0);
	});
});
