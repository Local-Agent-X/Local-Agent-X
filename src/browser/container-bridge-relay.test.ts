import { createConnection } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CONTAINER_BROWSER_RELAY_FLAG,
	CONTAINER_BROWSER_RELAY_SOCKET,
	CONTAINER_BROWSER_RELAY_TOKEN,
	MAX_BROWSER_RELAY_FRAME_BYTES,
	browserContainerRelayActivated,
	relayBrowserAbort,
	relayBrowserRequest,
	startBrowserContainerRelay,
	type BrowserRelayServerHandle,
} from "./container-bridge-relay.js";

const token = "a".repeat(64);
const SESSION = "s1";
const VIEW = `view-${SESSION}-default`; // owned by SESSION (viewBelongsToSession)
const handles: BrowserRelayServerHandle[] = [];
const original = {
	flag: process.env[CONTAINER_BROWSER_RELAY_FLAG],
	socket: process.env[CONTAINER_BROWSER_RELAY_SOCKET],
	token: process.env[CONTAINER_BROWSER_RELAY_TOKEN],
};

function endpoint(name: string): string {
	return process.platform === "win32"
		? `\\\\.\\pipe\\lax-browser-relay-${process.pid}-${name}`
		: join(tmpdir(), `lax-browser-relay-${process.pid}-${name}.sock`);
}

function activate(socketPath: string, secret = token): void {
	process.env[CONTAINER_BROWSER_RELAY_FLAG] = "1";
	process.env[CONTAINER_BROWSER_RELAY_SOCKET] = socketPath;
	process.env[CONTAINER_BROWSER_RELAY_TOKEN] = secret;
}

afterEach(async () => {
	await Promise.all(handles.splice(0).map(handle => handle.close()));
	for (const [key, value] of Object.entries(original)) {
		const envKey = key === "flag" ? CONTAINER_BROWSER_RELAY_FLAG
			: key === "socket" ? CONTAINER_BROWSER_RELAY_SOCKET : CONTAINER_BROWSER_RELAY_TOKEN;
		if (value === undefined) delete process.env[envKey];
		else process.env[envKey] = value;
	}
});

describe("container browser relay", () => {
	it("activates only through the explicit relay flag", () => {
		delete process.env[CONTAINER_BROWSER_RELAY_FLAG];
		expect(browserContainerRelayActivated()).toBe(false);
		process.env[CONTAINER_BROWSER_RELAY_SOCKET] = endpoint("inactive");
		process.env[CONTAINER_BROWSER_RELAY_TOKEN] = token;
		expect(browserContainerRelayActivated()).toBe(false);
		process.env[CONTAINER_BROWSER_RELAY_FLAG] = "1";
		expect(browserContainerRelayActivated()).toBe(true);
	});

	it("authenticates and forwards a canonical request without changing its result", async () => {
		const socketPath = endpoint("request");
		const request = vi.fn(async () => ({ userActive: true, result: { ok: true } }));
		const handle = await startBrowserContainerRelay({
			socketPath,
			token,
			ownerSessionId: SESSION,
			handler: { request, abort: vi.fn() },
		});
		handles.push(handle);
		activate(socketPath);
		const message = { type: "lax:browser-input", viewId: VIEW, event: { type: "char", keyCode: "x" } };
		await expect(relayBrowserRequest({ op: "input", viewId: VIEW, message, timeoutMs: 5_000 }))
			.resolves.toEqual({ userActive: true, result: { ok: true } });
		expect(request).toHaveBeenCalledWith({ op: "input", viewId: VIEW, message, timeoutMs: 5_000 });
	});

	it("refuses an op targeting another session's view without invoking the handler", async () => {
		const socketPath = endpoint("cross-session");
		const request = vi.fn();
		handles.push(await startBrowserContainerRelay({
			socketPath,
			token,
			ownerSessionId: SESSION,
			handler: { request, abort: vi.fn() },
		}));
		activate(socketPath);
		// A well-formed, correctly-authenticated request for a view owned by a
		// DIFFERENT session. Before the ownership check this was accepted.
		const foreignView = "view-s2-default";
		const message = { type: "lax:browser-capture", viewId: foreignView };
		await expect(relayBrowserRequest({ op: "capture", viewId: foreignView, message, timeoutMs: 5_000 }))
			.rejects.toThrow("not owned by this session");
		expect(request).not.toHaveBeenCalled();
	});

	it("accepts a same-session view whose profile id itself contains hyphens", async () => {
		// Custom profiles are minted `prof-<b36>-<hex>` (two hyphens); the tab
		// variant appends `-tN`. The lossy sessionIdFromViewId parser split these
		// wrong and rejected the session's OWN legitimate ops — would-fail-before.
		const socketPath = endpoint("hyphen-profile");
		const request = vi.fn(async () => ({ result: { ok: true } }));
		handles.push(await startBrowserContainerRelay({
			socketPath,
			token,
			ownerSessionId: SESSION,
			handler: { request, abort: vi.fn() },
		}));
		activate(socketPath);
		for (const viewId of [`view-${SESSION}-prof-lz9k2p-4f2a1c`, `view-${SESSION}-prof-lz9k2p-4f2a1c-t3`]) {
			request.mockClear();
			const message = { type: "lax:browser-capture", viewId };
			await expect(relayBrowserRequest({ op: "capture", viewId, message, timeoutMs: 5_000 }))
				.resolves.toEqual({ result: { ok: true } });
			expect(request).toHaveBeenCalledWith({ op: "capture", viewId, message, timeoutMs: 5_000 });
		}
	});

	it("refuses a sibling session whose id merely shares this session's prefix", async () => {
		// `view-s1-…` must never match a distinct session named `s12`: the trailing
		// hyphen in the owner prefix is what keeps the ids apart.
		const socketPath = endpoint("sibling-prefix");
		const request = vi.fn();
		handles.push(await startBrowserContainerRelay({
			socketPath,
			token,
			ownerSessionId: SESSION,
			handler: { request, abort: vi.fn() },
		}));
		activate(socketPath);
		const foreignView = "view-s12-default";
		const message = { type: "lax:browser-capture", viewId: foreignView };
		await expect(relayBrowserRequest({ op: "capture", viewId: foreignView, message, timeoutMs: 5_000 }))
			.rejects.toThrow("not owned by this session");
		expect(request).not.toHaveBeenCalled();
	});

	it("filters a pool list down to the caller's own views and passes the * sentinel", async () => {
		// lifecycle:list is a whole-pool query the desktop answers ignoring the
		// viewId. Before the fix a container received every session's url/title;
		// the "*" sentinel the list caller sends was also rejected outright.
		const socketPath = endpoint("list-filter");
		const own = `view-${SESSION}-default`;
		const request = vi.fn(async () => ({
			views: [
				{ viewId: own, partition: "p", url: "https://own.example", title: "Own", attached: true, agentDriven: true },
				{ viewId: "view-s2-default", partition: "p", url: "https://secret.example", title: "Secret", attached: true, agentDriven: true },
				{ viewId: "foreground", partition: "p", url: "https://user.example", title: "User", attached: true, agentDriven: false },
			],
		}));
		handles.push(await startBrowserContainerRelay({
			socketPath,
			token,
			ownerSessionId: SESSION,
			handler: { request, abort: vi.fn() },
		}));
		activate(socketPath);
		const message = { type: "lax:browser-lifecycle", op: "list", viewId: "*" };
		const result = await relayBrowserRequest({ op: "lifecycle:list", viewId: "*", message, timeoutMs: 5_000 });
		expect(request).toHaveBeenCalled(); // the "*" sentinel was NOT rejected
		expect(result).toEqual({ views: [expect.objectContaining({ viewId: own, url: "https://own.example" })] });
	});

	it("refuses clear-partition from a container caller without invoking the handler", async () => {
		// clear-partition wipes a profile-scoped, cross-session login partition;
		// no in-container caller legitimately mints it.
		const socketPath = endpoint("clear-partition");
		const request = vi.fn();
		handles.push(await startBrowserContainerRelay({
			socketPath,
			token,
			ownerSessionId: SESSION,
			handler: { request, abort: vi.fn() },
		}));
		activate(socketPath);
		const partition = "persist:lax-profile-prof-lz9k2p-4f2a1c";
		const message = { type: "lax:browser-clear-partition", partition };
		await expect(relayBrowserRequest({ op: "clear-partition", viewId: partition, message, timeoutMs: 5_000 }))
			.rejects.toThrow("clear-partition is not available to container sessions");
		expect(request).not.toHaveBeenCalled();
	});

	it("refuses an op targeting a user/foreground view the container never owns", async () => {
		const socketPath = endpoint("user-view");
		const request = vi.fn();
		handles.push(await startBrowserContainerRelay({
			socketPath,
			token,
			ownerSessionId: SESSION,
			handler: { request, abort: vi.fn() },
		}));
		activate(socketPath);
		const message = { type: "lax:browser-capture", viewId: "foreground" };
		await expect(relayBrowserRequest({ op: "capture", viewId: "foreground", message, timeoutMs: 5_000 }))
			.rejects.toThrow("not owned by this session");
		expect(request).not.toHaveBeenCalled();
	});

	it("refuses a cross-session abort without invoking the handler", async () => {
		const socketPath = endpoint("cross-abort");
		const abort = vi.fn();
		handles.push(await startBrowserContainerRelay({
			socketPath,
			token,
			ownerSessionId: SESSION,
			handler: { request: vi.fn(), abort },
		}));
		activate(socketPath);
		await expect(relayBrowserAbort("view-s2-default")).rejects.toThrow("not owned by this session");
		expect(abort).not.toHaveBeenCalled();
	});

	it("rejects a malformed or oversized viewId before it leaves the client", async () => {
		activate(endpoint("bad-viewid"));
		await expect(relayBrowserRequest({
			op: "capture",
			viewId: "x".repeat(513),
			message: { type: "lax:browser-capture", viewId: "x".repeat(513) },
			timeoutMs: 1_000,
		})).rejects.toThrow("invalid browser relay view identity");
		await expect(relayBrowserAbort("")).rejects.toThrow("invalid browser relay view identity");
	});

	it("forwards abort and acknowledges cleanup", async () => {
		const socketPath = endpoint("abort");
		const abort = vi.fn();
		handles.push(await startBrowserContainerRelay({
			socketPath,
			token,
			ownerSessionId: SESSION,
			handler: { request: vi.fn(), abort },
		}));
		activate(socketPath);
		await relayBrowserAbort(VIEW);
		expect(abort).toHaveBeenCalledWith(VIEW);
	});

	it("replaces the prior in-process owner when reopening the same endpoint", async () => {
		const socketPath = endpoint("restart");
		const handler = { request: vi.fn(), abort: vi.fn() };
		const first = await startBrowserContainerRelay({ socketPath, token, ownerSessionId: SESSION, handler });
		handles.push(first);
		const second = await startBrowserContainerRelay({ socketPath, token, ownerSessionId: SESSION, handler });
		handles.push(second);
		activate(socketPath);
		const restartedView = `view-${SESSION}-restart`;
		await relayBrowserAbort(restartedView);
		expect(handler.abort).toHaveBeenCalledWith(restartedView);
	});

	it("rejects an unauthenticated client without invoking the handler", async () => {
		const socketPath = endpoint("auth");
		const request = vi.fn();
		handles.push(await startBrowserContainerRelay({
			socketPath,
			token,
			ownerSessionId: SESSION,
			handler: { request, abort: vi.fn() },
		}));
		activate(socketPath, "b".repeat(64));
		await expect(relayBrowserRequest({
			op: "capture",
			viewId: VIEW,
			message: { type: "lax:browser-capture", viewId: VIEW },
			timeoutMs: 1_000,
		})).rejects.toThrow();
		expect(request).not.toHaveBeenCalled();
	});

	it("drops malformed and multi-frame input before dispatch", async () => {
		const socketPath = endpoint("framing");
		const request = vi.fn();
		handles.push(await startBrowserContainerRelay({
			socketPath,
			token,
			ownerSessionId: SESSION,
			handler: { request, abort: vi.fn() },
		}));
		await new Promise<void>((resolve, reject) => {
			const socket = createConnection(socketPath);
			socket.once("error", reject);
			socket.once("close", () => resolve());
			socket.once("connect", () => socket.write("{}\n{}\n"));
		});
		expect(request).not.toHaveBeenCalled();
	});

	it("fails closed when activation is incomplete", async () => {
		process.env[CONTAINER_BROWSER_RELAY_FLAG] = "1";
		delete process.env[CONTAINER_BROWSER_RELAY_SOCKET];
		delete process.env[CONTAINER_BROWSER_RELAY_TOKEN];
		await expect(relayBrowserRequest({
			op: "capture",
			viewId: "view-4",
			message: { type: "lax:browser-capture", viewId: "view-4" },
			timeoutMs: 1_000,
		})).rejects.toThrow("configuration is invalid");
	});

	it("rejects an oversized outbound frame before connecting", async () => {
		activate(endpoint("oversized"));
		await expect(relayBrowserRequest({
			op: "exec",
			viewId: "view-5",
			message: {
				type: "lax:browser-exec",
				viewId: "view-5",
				script: "x".repeat(MAX_BROWSER_RELAY_FRAME_BYTES),
			},
			timeoutMs: 1_000,
		})).rejects.toThrow("frame exceeded its limit");
	});
});
