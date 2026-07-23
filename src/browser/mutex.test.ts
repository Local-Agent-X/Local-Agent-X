import { describe, it, expect, afterEach, vi } from "vitest";
import type { LAXConfig } from "../types/lax-config.js";

// mutex.ts serializes browser actions. Its behavior is entirely determined by
// browserMode: isolated/continuity/in-app get PER-SESSION chains (independent
// sessions never block each other), while advanced-shared keeps ONE global
// chain (all sessions drive a single shared Playwright context, which genuinely
// races). browserMode is the only seam mocked; the mutex itself runs for real.
// Every case uses UNIQUE session ids so the module-level per-session chain and
// pacing maps — which persist across cases within this file — never bleed.
const state = vi.hoisted(() => ({ browserMode: "isolated" as string }));

vi.mock("../config.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../config.js")>();
	return {
		...original,
		// The mutex reads only browserMode off the runtime config.
		getRuntimeConfig: () => ({ browserMode: state.browserMode } as unknown as LAXConfig),
	};
});

import { withBrowserLock, getCurrentBrowserOwnerSessionId, __sessionChainCountForTest } from "./mutex.js";

/** A promise whose resolution we control, to hold a locked fn "inside" its
 *  critical section and prove (non-)overlap deterministically. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}

/** Drain pending microtasks + a chain `.then` (a session's FIRST action incurs
 *  no real pacing wait, so a short macrotask is enough to let it enter). */
function flush(): Promise<void> {
	return new Promise((r) => setTimeout(r, 5));
}

afterEach(() => {
	state.browserMode = "isolated";
});

describe("withBrowserLock", () => {
	it("(a) two DIFFERENT sessions in isolated mode run CONCURRENTLY (no cross-session serialization)", async () => {
		state.browserMode = "isolated";
		const releaseA = deferred();
		let aEntered = false, aExited = false, bDone = false;

		const pA = withBrowserLock("iso-A", async () => {
			aEntered = true;
			await releaseA.promise;
			aExited = true;
		});
		await flush();
		expect(aEntered).toBe(true); // A is inside its critical section, blocked on the deferred

		const onQueued = vi.fn();
		const pB = withBrowserLock("iso-B", async () => { bDone = true; return "b"; }, onQueued);

		// B runs to completion WHILE A is still blocked — the two locked fns
		// overlap in time, so independent sessions are not serialized.
		expect(await pB).toBe("b");
		expect(bDone).toBe(true);
		expect(aExited).toBe(false);
		// A different session on a per-session lock is not "queued" behind anyone.
		expect(onQueued).not.toHaveBeenCalled();

		releaseA.resolve();
		await pA;
		expect(aExited).toBe(true);
	});

	it("(b) the SAME session still serializes its own actions in submission order (FIFO)", async () => {
		state.browserMode = "isolated";
		const order: string[] = [];
		const release1 = deferred();

		const p1 = withBrowserLock("same-S", async () => {
			order.push("1-enter");
			await release1.promise;
			order.push("1-exit");
		});
		const p2 = withBrowserLock("same-S", async () => { order.push("2-enter"); });

		await flush();
		expect(order).toEqual(["1-enter"]); // action 2 waits behind action 1 — not started yet

		release1.resolve();
		await Promise.all([p1, p2]);
		expect(order).toEqual(["1-enter", "1-exit", "2-enter"]);
	});

	it("(c) advanced-shared mode SERIALIZES across DIFFERENT sessions (global lock retained)", async () => {
		state.browserMode = "advanced-shared";
		const order: string[] = [];
		const releaseA = deferred();

		const pA = withBrowserLock("sh-A", async () => {
			order.push("A-enter");
			await releaseA.promise;
			order.push("A-exit");
		});
		await flush();
		expect(order).toEqual(["A-enter"]);
		expect(getCurrentBrowserOwnerSessionId()).toBe("sh-A");

		// B is enqueued while A holds the single global lock: it must be told it is
		// waiting (browser_queued via onQueued) AND must not start until A is done.
		const onQueued = vi.fn();
		const pB = withBrowserLock("sh-B", async () => { order.push("B-enter"); }, onQueued);
		expect(onQueued).toHaveBeenCalledTimes(1);

		await flush();
		expect(order).toEqual(["A-enter"]); // B still blocked behind A, across sessions

		releaseA.resolve();
		await Promise.all([pA, pB]);
		expect(order).toEqual(["A-enter", "A-exit", "B-enter"]);
	});

	it("a failed action does not poison later actions on the same session chain", async () => {
		state.browserMode = "isolated";
		await expect(
			withBrowserLock("poison-S", async () => { throw new Error("boom"); }),
		).rejects.toThrow("boom");
		// The next action on the SAME session's chain still runs and resolves.
		await expect(withBrowserLock("poison-S", async () => "ok")).resolves.toBe("ok");
	});

	it("getCurrentBrowserOwnerSessionId reports the active owner and clears afterward", async () => {
		state.browserMode = "isolated";
		expect(getCurrentBrowserOwnerSessionId()).toBeNull();
		const release = deferred();
		let ownerDuring: string | null = null;
		const p = withBrowserLock("owner-S", async () => {
			ownerDuring = getCurrentBrowserOwnerSessionId();
			await release.promise;
		});
		await flush();
		expect(ownerDuring).toBe("owner-S");
		release.resolve();
		await p;
		expect(getCurrentBrowserOwnerSessionId()).toBeNull();
	});

	it("evicts a session's idle per-session chain (no unbounded sessionChains growth)", async () => {
		state.browserMode = "isolated";
		const before = __sessionChainCountForTest();
		await withBrowserLock("evict-unique-S", async () => "done");
		await flush(); // let the settled tail's self-eviction microtask run
		expect(__sessionChainCountForTest()).toBe(before); // its entry self-evicted
	});
});
