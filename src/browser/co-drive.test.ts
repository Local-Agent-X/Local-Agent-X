/**
 * Co-drive (C1) server-side surface: the human-priority "userActive"
 * refusal travels the bridge as a RESOLVED status — never a rejection —
 * and the typed guard classifies it for the backend.
 *
 * The desktop-side lock/suppression state machine lives in
 * desktop/src/in-app-browser.ts (no vitest infra there — exercised via a
 * standalone pure-function runner); this file covers the server pieces.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../security/layer/index.js", () => ({
	evaluateEgressForUrl: () => ({ allowed: false, reason: "unused" }),
}));
vi.mock("../config.js", () => ({
	getRuntimeConfig: () => ({ port: 7007 }),
}));

import {
	BridgeOpError,
	browserInput,
	browserNavigate,
	isUserActiveResult,
	type BrowserInputResult,
	type UserActiveResult,
} from "./bridge-client.js";

const originalSend = process.send;
const originalEnv = process.env.LAX_DESKTOP_BRIDGE;
const sendMock = vi.fn<(msg: unknown) => boolean>();

interface SentMessage { type: string; id?: number; [key: string]: unknown }

function lastSent(): SentMessage {
	const calls = sendMock.mock.calls;
	expect(calls.length).toBeGreaterThan(0);
	return calls[calls.length - 1][0] as SentMessage;
}

function receive(msg: Record<string, unknown>): void {
	(process as unknown as { emit(event: string, ...args: unknown[]): boolean }).emit("message", msg);
}

beforeEach(() => {
	sendMock.mockReset().mockReturnValue(true);
	process.env.LAX_DESKTOP_BRIDGE = "1";
	// eslint-disable-next-line @typescript-eslint/unbound-method
	process.send = sendMock as unknown as typeof process.send;
});

afterEach(() => {
	process.send = originalSend;
	if (originalEnv === undefined) delete process.env.LAX_DESKTOP_BRIDGE;
	else process.env.LAX_DESKTOP_BRIDGE = originalEnv;
});

describe("browserInput co-drive status", () => {
	it("resolves { userActive: true } when the desktop refuses with the human-priority lock", async () => {
		const p = browserInput("v1", { type: "mouseMove", x: 10, y: 20 });
		const msg = lastSent();
		expect(msg).toMatchObject({ type: "lax:browser-input", viewId: "v1" });
		receive({ type: "lax:browser-input-result", id: msg.id, ok: false, userActive: true });
		await expect(p).resolves.toEqual({ userActive: true });
	});

	it("resolves undefined on a plain ok dispatch (B1 shape unchanged)", async () => {
		const p = browserInput("v1", { type: "keyDown", keyCode: "a" });
		receive({ type: "lax:browser-input-result", id: lastSent().id, ok: true });
		await expect(p).resolves.toBeUndefined();
	});

	it("still rejects a real failure (ok:false WITHOUT userActive)", async () => {
		const p = browserInput("v1", { type: "keyDown", keyCode: "a" });
		receive({ type: "lax:browser-input-result", id: lastSent().id, ok: false, error: "no browser view \"v1\"" });
		await expect(p).rejects.toBeInstanceOf(BridgeOpError);
	});

	it("does not treat userActive as a status on a non-boolean/absent flag", async () => {
		const p = browserInput("v1", { type: "char", keyCode: "a" });
		receive({ type: "lax:browser-input-result", id: lastSent().id, ok: false, userActive: "yes", error: "boom" });
		await expect(p).rejects.toBeInstanceOf(BridgeOpError);
	});

	it("userActive reclassification is scoped to the input op — a failed navigate carrying the flag still rejects", async () => {
		const p = browserNavigate("v1", "https://example.com");
		receive({ type: "lax:browser-navigate-result", id: lastSent().id, ok: false, userActive: true, error: "load failed" });
		await expect(p).rejects.toBeInstanceOf(BridgeOpError);
	});
});

describe("isUserActiveResult", () => {
	it("classifies the preemption status", () => {
		const preempted: BrowserInputResult = { userActive: true };
		const sent: BrowserInputResult = undefined;
		expect(isUserActiveResult(preempted)).toBe(true);
		expect(isUserActiveResult(sent)).toBe(false);
		if (isUserActiveResult(preempted)) {
			const narrowed: UserActiveResult = preempted; // type-level: guard narrows
			expect(narrowed.userActive).toBe(true);
		}
	});
});
