// User-loopback egress carve-out (browser-loopback-policy.ts) — the rule that
// lets the user's OWN in-app tabs reach literal-loopback services (their
// ComfyUI, their dev server) while agent views, popups, and internet pages
// stay under the strict SSRF egress policy. Regression context: without the
// carve-out, every request to 127.0.0.1:<non-LAX-port> was cancelled and the
// browser pane sat silently white.
import { describe, expect, it } from "vitest";
import { isLoopbackHostname, shouldAllowUserLoopback, type ViewTrust } from "./browser-loopback-policy";

const trustMap = (map: Record<number, ViewTrust>) => (id: number) => map[id] ?? null;
const USER_WC = 1;
const AGENT_WC = 2;
const resolve = trustMap({ [USER_WC]: "user", [AGENT_WC]: "agent" });

describe("isLoopbackHostname", () => {
	it("accepts the literal loopback forms only", () => {
		expect(isLoopbackHostname("127.0.0.1")).toBe(true);
		expect(isLoopbackHostname("localhost")).toBe(true);
		expect(isLoopbackHostname("::1")).toBe(true);
		expect(isLoopbackHostname("[::1]")).toBe(true);
		expect(isLoopbackHostname("LOCALHOST")).toBe(true);
	});

	it("rejects resolvable hostnames and private ranges — DNS-rebinding stays closed", () => {
		expect(isLoopbackHostname("evil.example")).toBe(false);
		expect(isLoopbackHostname("192.168.1.1")).toBe(false);
		expect(isLoopbackHostname("127.0.0.1.evil.example")).toBe(false);
		expect(isLoopbackHostname("mybox.local")).toBe(false);
	});
});

describe("shouldAllowUserLoopback", () => {
	it("user view: top-level navigation to a loopback service is allowed", () => {
		expect(shouldAllowUserLoopback(
			{ url: "http://127.0.0.1:8188/", resourceType: "mainFrame", webContentsId: USER_WC },
			resolve,
		)).toBe(true);
		expect(shouldAllowUserLoopback(
			{ url: "http://localhost:3000/app", resourceType: "mainFrame", webContentsId: USER_WC },
			resolve,
		)).toBe(true);
		expect(shouldAllowUserLoopback(
			{ url: "http://[::1]:9000/", resourceType: "mainFrame", webContentsId: USER_WC },
			resolve,
		)).toBe(true);
	});

	it("user view: a loopback page's own subresources/XHR/WebSockets are allowed", () => {
		expect(shouldAllowUserLoopback(
			{ url: "http://127.0.0.1:8188/api/queue", resourceType: "xhr", initiator: "http://127.0.0.1:8188", webContentsId: USER_WC },
			resolve,
		)).toBe(true);
		expect(shouldAllowUserLoopback(
			{ url: "ws://127.0.0.1:8188/ws", resourceType: "webSocket", initiator: "http://127.0.0.1:8188", webContentsId: USER_WC },
			resolve,
		)).toBe(true);
	});

	it("user view: an INTERNET page cannot probe loopback (the SSRF invariant)", () => {
		expect(shouldAllowUserLoopback(
			{ url: "http://127.0.0.1:8188/api", resourceType: "xhr", initiator: "https://evil.example", webContentsId: USER_WC },
			resolve,
		)).toBe(false);
		// No initiator on a non-navigation request → strict.
		expect(shouldAllowUserLoopback(
			{ url: "http://127.0.0.1:8188/api", resourceType: "xhr", webContentsId: USER_WC },
			resolve,
		)).toBe(false);
	});

	it("agent views and unattributable requests stay under the strict policy", () => {
		expect(shouldAllowUserLoopback(
			{ url: "http://127.0.0.1:8188/", resourceType: "mainFrame", webContentsId: AGENT_WC },
			resolve,
		)).toBe(false);
		expect(shouldAllowUserLoopback(
			{ url: "http://127.0.0.1:8188/", resourceType: "mainFrame", webContentsId: 777 },
			resolve,
		)).toBe(false);
		expect(shouldAllowUserLoopback(
			{ url: "http://127.0.0.1:8188/", resourceType: "mainFrame" },
			resolve,
		)).toBe(false);
	});

	it("never opens non-loopback targets or non-network schemes", () => {
		expect(shouldAllowUserLoopback(
			{ url: "https://example.com/", resourceType: "mainFrame", webContentsId: USER_WC },
			resolve,
		)).toBe(false);
		expect(shouldAllowUserLoopback(
			{ url: "http://192.168.1.1/", resourceType: "mainFrame", webContentsId: USER_WC },
			resolve,
		)).toBe(false);
		expect(shouldAllowUserLoopback(
			{ url: "file:///etc/passwd", resourceType: "mainFrame", webContentsId: USER_WC },
			resolve,
		)).toBe(false);
		expect(shouldAllowUserLoopback(
			{ url: "not a url", resourceType: "mainFrame", webContentsId: USER_WC },
			resolve,
		)).toBe(false);
	});
});
