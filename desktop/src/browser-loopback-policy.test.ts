// Local-loopback egress carve-out (browser-loopback-policy.ts) — the rule that
// lets a user's OWN in-app tabs reach literal-loopback services (their ComfyUI,
// their dev server) AND lets an agent view load the loopback subresources of a
// same-machine page (the app it's building), while agent NAVIGATION, popups,
// and internet pages stay under the strict SSRF egress policy. Regression
// context: without the carve-out, every request to 127.0.0.1:<non-LAX-port> was
// cancelled and the browser pane sat silently white.
import { describe, expect, it } from "vitest";
import { isLoopbackHostname, shouldAllowLocalLoopback, type ViewTrust } from "./browser-loopback-policy";

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

describe("shouldAllowLocalLoopback", () => {
	it("user view: top-level navigation to a loopback service is allowed", () => {
		expect(shouldAllowLocalLoopback(
			{ url: "http://127.0.0.1:8188/", resourceType: "mainFrame", webContentsId: USER_WC },
			resolve,
		)).toBe(true);
		expect(shouldAllowLocalLoopback(
			{ url: "http://localhost:3000/app", resourceType: "mainFrame", webContentsId: USER_WC },
			resolve,
		)).toBe(true);
		expect(shouldAllowLocalLoopback(
			{ url: "http://[::1]:9000/", resourceType: "mainFrame", webContentsId: USER_WC },
			resolve,
		)).toBe(true);
	});

	it("user view: a loopback page's own subresources/XHR/WebSockets are allowed", () => {
		expect(shouldAllowLocalLoopback(
			{ url: "http://127.0.0.1:8188/api/queue", resourceType: "xhr", initiator: "http://127.0.0.1:8188", webContentsId: USER_WC },
			resolve,
		)).toBe(true);
		expect(shouldAllowLocalLoopback(
			{ url: "ws://127.0.0.1:8188/ws", resourceType: "webSocket", initiator: "http://127.0.0.1:8188", webContentsId: USER_WC },
			resolve,
		)).toBe(true);
	});

	it("agent view: loopback subresources of a same-machine page load (the app it's building)", () => {
		// The app is served on the LAX self-port and pulls its Vite dev-server
		// chunks + HMR socket off a loopback port; the initiator is loopback.
		expect(shouldAllowLocalLoopback(
			{ url: "http://127.0.0.1:3001/@vite/client", resourceType: "script", initiator: "http://127.0.0.1:7007", webContentsId: AGENT_WC },
			resolve,
		)).toBe(true);
		expect(shouldAllowLocalLoopback(
			{ url: "ws://127.0.0.1:3001/", resourceType: "webSocket", initiator: "http://127.0.0.1:3001", webContentsId: AGENT_WC },
			resolve,
		)).toBe(true);
	});

	it("agent view: a same-machine redirect (loopback → loopback) navigation loads — the self-port handing off to the dev server", () => {
		expect(shouldAllowLocalLoopback(
			{ url: "http://127.0.0.1:3001/apps/merchhelm/", resourceType: "mainFrame", initiator: "http://127.0.0.1:7007", webContentsId: AGENT_WC },
			resolve,
		)).toBe(true);
	});

	it("agent view: navigation to a loopback service from a NON-loopback page stays strict (no SSRF-by-nav)", () => {
		// A hostile internet page trying to redirect the agent into a local service.
		expect(shouldAllowLocalLoopback(
			{ url: "http://127.0.0.1:8188/shutdown", resourceType: "mainFrame", initiator: "https://evil.example", webContentsId: AGENT_WC },
			resolve,
		)).toBe(false);
		// And a bare agent navigation with no loopback origin behind it.
		expect(shouldAllowLocalLoopback(
			{ url: "http://127.0.0.1:8188/", resourceType: "mainFrame", webContentsId: AGENT_WC },
			resolve,
		)).toBe(false);
	});

	it("an INTERNET page cannot probe loopback in any view (the SSRF invariant)", () => {
		expect(shouldAllowLocalLoopback(
			{ url: "http://127.0.0.1:8188/api", resourceType: "xhr", initiator: "https://evil.example", webContentsId: USER_WC },
			resolve,
		)).toBe(false);
		expect(shouldAllowLocalLoopback(
			{ url: "http://127.0.0.1:8188/api", resourceType: "xhr", initiator: "https://evil.example", webContentsId: AGENT_WC },
			resolve,
		)).toBe(false);
		// No initiator on a non-navigation request → strict.
		expect(shouldAllowLocalLoopback(
			{ url: "http://127.0.0.1:8188/api", resourceType: "xhr", webContentsId: AGENT_WC },
			resolve,
		)).toBe(false);
	});

	it("unattributable requests (unknown/absent webContents) stay under the strict policy", () => {
		expect(shouldAllowLocalLoopback(
			{ url: "http://127.0.0.1:8188/", resourceType: "mainFrame", webContentsId: 777 },
			resolve,
		)).toBe(false);
		expect(shouldAllowLocalLoopback(
			{ url: "http://127.0.0.1:8188/", resourceType: "mainFrame" },
			resolve,
		)).toBe(false);
		// A loopback-initiator subresource from an unknown webContents is still strict.
		expect(shouldAllowLocalLoopback(
			{ url: "http://127.0.0.1:8188/api", resourceType: "xhr", initiator: "http://127.0.0.1:8188", webContentsId: 777 },
			resolve,
		)).toBe(false);
	});

	it("never opens non-loopback targets or non-network schemes", () => {
		expect(shouldAllowLocalLoopback(
			{ url: "https://example.com/", resourceType: "mainFrame", webContentsId: USER_WC },
			resolve,
		)).toBe(false);
		expect(shouldAllowLocalLoopback(
			{ url: "http://192.168.1.1/", resourceType: "mainFrame", webContentsId: USER_WC },
			resolve,
		)).toBe(false);
		expect(shouldAllowLocalLoopback(
			{ url: "file:///etc/passwd", resourceType: "mainFrame", webContentsId: USER_WC },
			resolve,
		)).toBe(false);
		expect(shouldAllowLocalLoopback(
			{ url: "not a url", resourceType: "mainFrame", webContentsId: USER_WC },
			resolve,
		)).toBe(false);
	});
});
