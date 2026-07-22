import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	browserAbort,
	browserAbortDesktop,
	browserExec,
	browserInput,
	requestDesktopBrowserBridge,
} from "./bridge-client.js";
import {
	CONTAINER_BROWSER_RELAY_FLAG,
	CONTAINER_BROWSER_RELAY_SOCKET,
	CONTAINER_BROWSER_RELAY_TOKEN,
	startBrowserContainerRelay,
	type BrowserRelayServerHandle,
} from "./container-bridge-relay.js";

const originalSend = process.send;
const originalEnv = {
	desktop: process.env.LAX_DESKTOP_BRIDGE,
	flag: process.env[CONTAINER_BROWSER_RELAY_FLAG],
	socket: process.env[CONTAINER_BROWSER_RELAY_SOCKET],
	token: process.env[CONTAINER_BROWSER_RELAY_TOKEN],
};
const send = vi.fn<(message: unknown) => boolean>();
let relay: BrowserRelayServerHandle;

function endpoint(): string {
	return process.platform === "win32"
		? `\\\\.\\pipe\\lax-browser-canonical-${process.pid}`
		: join(tmpdir(), `lax-browser-canonical-${process.pid}.sock`);
}

function receive(message: Record<string, unknown>): void {
	(process as unknown as { emit(event: string, value: unknown): boolean }).emit("message", message);
}

function restore(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

beforeAll(async () => {
	const socketPath = endpoint();
	process.env.LAX_DESKTOP_BRIDGE = "1";
	process.env[CONTAINER_BROWSER_RELAY_FLAG] = "1";
	process.env[CONTAINER_BROWSER_RELAY_SOCKET] = socketPath;
	process.env[CONTAINER_BROWSER_RELAY_TOKEN] = "c".repeat(64);
	process.send = send.mockReturnValue(true) as unknown as typeof process.send;
	relay = await startBrowserContainerRelay({
		socketPath,
		token: "c".repeat(64),
		handler: { request: requestDesktopBrowserBridge, abort: browserAbortDesktop },
	});
});

afterAll(async () => {
	await relay.close();
	process.send = originalSend;
	restore("LAX_DESKTOP_BRIDGE", originalEnv.desktop);
	restore(CONTAINER_BROWSER_RELAY_FLAG, originalEnv.flag);
	restore(CONTAINER_BROWSER_RELAY_SOCKET, originalEnv.socket);
	restore(CONTAINER_BROWSER_RELAY_TOKEN, originalEnv.token);
});

describe("container relay through the canonical browser bridge", () => {
	it("preserves input userActive status", async () => {
		const pending = browserInput("relay-view", { type: "char", keyCode: "x" });
		await vi.waitFor(() => expect(send).toHaveBeenCalled());
		const message = send.mock.calls.at(-1)?.[0] as { id: number; type: string };
		expect(message.type).toBe("lax:browser-input");
		receive({ type: "lax:browser-input-result", id: message.id, ok: false, userActive: true });
		await expect(pending).resolves.toEqual({ userActive: true });
	});

	it("preserves arbitrary exec results", async () => {
		const pending = browserExec("relay-view", "document.title");
		await vi.waitFor(() => expect(send.mock.calls.at(-1)?.[0]).toMatchObject({ type: "lax:browser-exec" }));
		const message = send.mock.calls.at(-1)?.[0] as { id: number };
		receive({ type: "lax:browser-exec-result", id: message.id, ok: true, result: { title: "Example" } });
		await expect(pending).resolves.toEqual({ title: "Example" });
	});

	it("forwards abort through the canonical desktop send path", async () => {
		browserAbort("relay-view");
		await vi.waitFor(() => expect(send.mock.calls.at(-1)?.[0]).toEqual({ type: "lax:browser-abort", viewId: "relay-view" }));
	});
});
