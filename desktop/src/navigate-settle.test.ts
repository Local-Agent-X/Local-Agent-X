/**
 * Unit tests for the in-app navigation settle semantics — the 2026-07-20
 * wedge class: a heavy CSR SPA that never quiesces must settle shortly after
 * dom-ready instead of outrunning the deadline (and the server's 29s wedge
 * timer, which force-reset a healthy session).
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleNavigation, type NavigableWebContents } from "./navigate-settle";

class FakeWebContents extends EventEmitter implements NavigableWebContents {
	url = "https://loaded.example/";
	title = "Loaded";
	destroyed = false;
	stopped = 0;
	loadUrlImpl: () => Promise<unknown> = () => Promise.resolve();

	loadURL(_url: string): Promise<unknown> { return this.loadUrlImpl(); }
	getURL(): string { return this.url; }
	getTitle(): string { return this.title; }
	stop(): void { this.stopped++; }
	isDestroyed(): boolean { return this.destroyed; }
}

let wc: FakeWebContents;

beforeEach(() => {
	vi.useFakeTimers();
	wc = new FakeWebContents();
});

afterEach(() => {
	vi.useRealTimers();
});

function start(overrides: { timeoutMs?: number; interactiveSettleMs?: number; onSuccess?: () => void } = {}) {
	return settleNavigation(wc, "https://target.example/", {
		timeoutMs: overrides.timeoutMs ?? 25_000,
		interactiveSettleMs: overrides.interactiveSettleMs ?? 3_000,
		onSuccess: overrides.onSuccess,
	});
}

/** Let the loadURL microtask + listener attachment flush. */
async function tick() { await vi.advanceTimersByTimeAsync(0); }

describe("settleNavigation", () => {
	it("fast page: settles on did-finish-load with url/title, no interactive flag", async () => {
		const p = start();
		await tick();
		wc.emit("did-start-loading");
		wc.emit("did-finish-load");
		const r = await p;
		expect(r).toMatchObject({ ok: true, url: "https://loaded.example/", title: "Loaded" });
		expect(r.interactive).toBeUndefined();
		expect(wc.stopped).toBe(0);
	});

	it("never-quiescing SPA: settles interactive after dom-ready + grace, WITHOUT stopping the load", async () => {
		const onSuccess = vi.fn();
		const p = start({ onSuccess });
		await tick();
		wc.emit("did-start-loading");
		wc.emit("dom-ready");
		// full load never fires; grace elapses
		await vi.advanceTimersByTimeAsync(3_000);
		const r = await p;
		expect(r).toMatchObject({ ok: true, interactive: true });
		expect(wc.stopped).toBe(0); // background load keeps streaming
		expect(onSuccess).toHaveBeenCalledTimes(1);
	});

	it("full load landing inside the grace window wins over the interactive settle", async () => {
		const p = start();
		await tick();
		wc.emit("did-start-loading");
		wc.emit("dom-ready");
		await vi.advanceTimersByTimeAsync(1_000);
		wc.emit("did-finish-load");
		const r = await p;
		expect(r.ok).toBe(true);
		expect(r.interactive).toBeUndefined();
	});

	it("ignores stale quiescence events from the PREVIOUS page (pre-did-start-loading)", async () => {
		const p = start({ timeoutMs: 10_000 });
		await tick();
		// Previous page (left loading by an interactive settle) stops now —
		// must NOT settle this navigation with the old URL.
		wc.emit("did-stop-loading");
		wc.emit("dom-ready");
		await vi.advanceTimersByTimeAsync(5_000);
		// Now the real navigation starts and finishes.
		wc.emit("did-start-loading");
		wc.emit("did-finish-load");
		const r = await p;
		expect(r.ok).toBe(true);
	});

	it("ignores a stale main-frame failure from the previous page before this navigation starts", async () => {
		const p = start({ timeoutMs: 10_000 });
		await tick();
		wc.emit("did-fail-load", {}, -105, "NAME_NOT_RESOLVED", "https://previous.example/", true);
		wc.emit("did-start-loading");
		wc.emit("did-finish-load");
		await expect(p).resolves.toMatchObject({ ok: true });
	});

	it("main-frame did-fail-load settles as error; code -3 (aborted) is ignored", async () => {
		const p = start();
		await tick();
		wc.emit("did-start-loading");
		wc.emit("did-fail-load", {}, -3, "aborted", "https://target.example/", true);
		wc.emit("did-fail-load", {}, -105, "NAME_NOT_RESOLVED", "https://target.example/", true);
		const r = await p;
		expect(r.ok).toBe(false);
		expect(String(r.error)).toContain("NAME_NOT_RESOLVED");
	});

	it("subframe failures never settle the navigation", async () => {
		const p = start();
		await tick();
		wc.emit("did-start-loading");
		wc.emit("did-fail-load", {}, -105, "NAME_NOT_RESOLVED", "https://ad.example/", false);
		wc.emit("did-finish-load");
		const r = await p;
		expect(r.ok).toBe(true);
	});

	it("captures the main-frame HTTP status from did-navigate", async () => {
		const p = start();
		await tick();
		wc.emit("did-start-loading");
		wc.emit("did-navigate", {}, "https://target.example/", 404);
		wc.emit("did-finish-load");
		const r = await p;
		expect(r).toMatchObject({ ok: true, status: 404 });
	});

	it("deadline (page never reaches dom-ready): errors AND stops the zombie load", async () => {
		const p = start({ timeoutMs: 25_000 });
		await tick();
		wc.emit("did-start-loading");
		await vi.advanceTimersByTimeAsync(25_000);
		const r = await p;
		expect(r.ok).toBe(false);
		expect(String(r.error)).toContain("did not settle within 25000ms");
		expect(wc.stopped).toBe(1);
	});

	it("loadURL rejection settles as error immediately", async () => {
		wc.loadUrlImpl = () => Promise.reject(new Error("ERR_INVALID_URL"));
		const r = await start();
		expect(r.ok).toBe(false);
		expect(String(r.error)).toContain("ERR_INVALID_URL");
	});

	it("removes every listener after settling (no leak across sequential navigations)", async () => {
		const p = start();
		await tick();
		wc.emit("did-start-loading");
		wc.emit("did-finish-load");
		await p;
		for (const ev of ["did-start-loading", "did-fail-load", "did-finish-load", "did-stop-loading", "did-navigate", "dom-ready"]) {
			expect(wc.listenerCount(ev), `listener leak on ${ev}`).toBe(0);
		}
	});
});
