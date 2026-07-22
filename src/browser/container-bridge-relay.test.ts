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
			handler: { request, abort: vi.fn() },
		});
		handles.push(handle);
		activate(socketPath);
		const message = { type: "lax:browser-input", viewId: "view-1", event: { type: "char", keyCode: "x" } };
		await expect(relayBrowserRequest({ op: "input", viewId: "view-1", message, timeoutMs: 5_000 }))
			.resolves.toEqual({ userActive: true, result: { ok: true } });
		expect(request).toHaveBeenCalledWith({ op: "input", viewId: "view-1", message, timeoutMs: 5_000 });
	});

	it("forwards abort and acknowledges cleanup", async () => {
		const socketPath = endpoint("abort");
		const abort = vi.fn();
		handles.push(await startBrowserContainerRelay({
			socketPath,
			token,
			handler: { request: vi.fn(), abort },
		}));
		activate(socketPath);
		await relayBrowserAbort("view-2");
		expect(abort).toHaveBeenCalledWith("view-2");
	});

	it("replaces the prior in-process owner when reopening the same endpoint", async () => {
		const socketPath = endpoint("restart");
		const handler = { request: vi.fn(), abort: vi.fn() };
		const first = await startBrowserContainerRelay({ socketPath, token, handler });
		handles.push(first);
		const second = await startBrowserContainerRelay({ socketPath, token, handler });
		handles.push(second);
		activate(socketPath);
		await relayBrowserAbort("view-restarted");
		expect(handler.abort).toHaveBeenCalledWith("view-restarted");
	});

	it("rejects an unauthenticated client without invoking the handler", async () => {
		const socketPath = endpoint("auth");
		const request = vi.fn();
		handles.push(await startBrowserContainerRelay({
			socketPath,
			token,
			handler: { request, abort: vi.fn() },
		}));
		activate(socketPath, "b".repeat(64));
		await expect(relayBrowserRequest({
			op: "capture",
			viewId: "view-3",
			message: { type: "lax:browser-capture", viewId: "view-3" },
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
