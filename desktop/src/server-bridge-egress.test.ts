/**
 * Regression tests for the per-hop egress ask deadline — the 2026-07-20
 * "in-app browser loses internet" class: the server child's event loop stalls
 * for SECONDS during agent turns (measured selectTools 10.5s), and the old
 * 250ms fail-closed deadline denied every in-flight request, rendering all
 * in-app tabs as ERR_BLOCKED_BY_CLIENT / "You're offline" exactly while the
 * agent was working. The deadline must tolerate real turn-time stalls while
 * keeping fail-closed semantics for a dead child / expired ask.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "child_process";

// browser-views drags in the Electron `app` singleton via window.ts/config.ts —
// unavailable under vitest. The ask client only calls viewIdForWebContents.
vi.mock("./browser-views", () => ({ viewIdForWebContents: () => null }));

import { askServerEgress, settleEgressAsk } from "./server-bridge-egress";

interface SentAsk { id: number; url: string }

function fakeProc(over: Partial<{ connected: boolean; killed: boolean; backpressured: boolean; sendError: Error }> = {}) {
	const sent: SentAsk[] = [];
	const proc = {
		connected: over.connected ?? true,
		killed: over.killed ?? false,
		send: (msg: SentAsk, callback?: (error: Error | null) => void) => {
			sent.push(msg);
			queueMicrotask(() => callback?.(over.sendError ?? null));
			return !over.backpressured;
		},
	};
	return { proc: proc as unknown as ChildProcess, sent };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("askServerEgress deadline semantics", () => {
	it("a reply that arrives after a multi-second server stall is still HONORED (the 250ms class)", async () => {
		const { proc, sent } = fakeProc();
		const ask = askServerEgress(proc, { url: "https://cloud.thrivemetrics.com/app" } as never);
		// Simulate the server event loop blocked for 10.5s (the measured
		// selectTools stall) before it answers ALLOW.
		await vi.advanceTimersByTimeAsync(10_500);
		settleEgressAsk(sent[0].id, true);
		await expect(ask).resolves.toEqual({ allowed: true });
	});

	it("fails closed once the deadline truly expires", async () => {
		const { proc } = fakeProc();
		const ask = askServerEgress(proc, { url: "https://example.com/" } as never);
		await vi.advanceTimersByTimeAsync(15_000);
		await expect(ask).resolves.toEqual({ allowed: false });
	});

	it("a reply after expiry is a no-op (ask already denied, id expired)", async () => {
		const { proc, sent } = fakeProc();
		const ask = askServerEgress(proc, { url: "https://example.com/" } as never);
		await vi.advanceTimersByTimeAsync(15_000);
		await expect(ask).resolves.toEqual({ allowed: false });
		expect(() => settleEgressAsk(sent[0].id, true)).not.toThrow();
	});

	it("a dead child denies immediately — the deadline never applies", async () => {
		const { proc } = fakeProc({ connected: false });
		await expect(askServerEgress(proc, { url: "https://example.com/" } as never)).resolves.toEqual({ allowed: false });
	});

	it("IPC backpressure does not deny a request that was queued", async () => {
		const { proc, sent } = fakeProc({ backpressured: true });
		const ask = askServerEgress(proc, { url: "https://example.com/" } as never);
		await vi.advanceTimersByTimeAsync(1_000);
		settleEgressAsk(sent[0].id, true);
		await expect(ask).resolves.toEqual({ allowed: true });
	});

	it("a send callback error denies immediately", async () => {
		const { proc } = fakeProc({ sendError: new Error("channel closed") });
		await expect(askServerEgress(proc, { url: "https://example.com/" } as never)).resolves.toEqual({ allowed: false });
	});
});
