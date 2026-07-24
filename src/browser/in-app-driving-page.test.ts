import { afterEach, describe, expect, it } from "vitest";
import {
	realDrivingPage,
	resolveDrivingPage,
	invalidateDrivingPage,
	_setPageResolverForTest,
} from "./in-app-driving-page.js";

// Fakes standing in for Playwright's Page — no real socket. Only isClosed() is
// touched by the leaf, so a fake Page is just a tagged object with a mutable
// closed flag. The fallback is a distinct tagged object so tests can assert
// identity ("got the real page" vs "got the fallback").
function fakePage(tag: string, closed = false) {
	return { tag, isClosed: () => closed };
}

// A live BridgeObservePage-shaped fallback, distinct from any real page.
const fallback = fakePage("fallback");

afterEach(() => {
	_setPageResolverForTest(null);
});

describe("resolveDrivingPage", () => {
	it("returns the real Page when the resolver yields a live one (not the fallback)", async () => {
		const real = fakePage("real");
		_setPageResolverForTest(async () => real as never);

		const page = await resolveDrivingPage("view-1", fallback as never);
		expect(page).toBe(real);
		expect(page).not.toBe(fallback);
	});

	it("returns the fallback when the resolver yields null (no CDP / not found)", async () => {
		_setPageResolverForTest(async () => null);

		const page = await resolveDrivingPage("view-1", fallback as never);
		expect(page).toBe(fallback);
	});

	it("drops a cached page once it reports isClosed() and re-resolves (not stale)", async () => {
		const dead = fakePage("dead");
		_setPageResolverForTest(async () => dead as never);

		// First resolve caches the live real page.
		expect(await resolveDrivingPage("view-1", fallback as never)).toBe(dead);

		// The underlying view is torn down: same viewId, the cached handle closes.
		dead.isClosed = () => true;
		// Now the resolver reports nothing (view gone) → must NOT hand back the
		// stale closed page; the fallback is served instead.
		_setPageResolverForTest(async () => null);

		expect(await resolveDrivingPage("view-1", fallback as never)).toBe(fallback);
	});

	it("self-heals a recreated view: same viewId, closed handle re-resolves to the new Page", async () => {
		// One resolver across the whole test (so the cache is never cleared by the
		// setter) — it returns `first` until that handle is marked closed, then the
		// freshly-created `second`, mimicking a recreated view reusing its viewId.
		const first = fakePage("first");
		const second = fakePage("second");
		_setPageResolverForTest(async () => (first.isClosed() ? (second as never) : (first as never)));

		// First resolve caches the live `first` page.
		expect(await resolveDrivingPage("view-1", fallback as never)).toBe(first);

		// View recreated: the cached handle closes. The next resolve must notice
		// via liveness self-heal (no external invalidate) and return `second`.
		first.isClosed = () => true;
		expect(await resolveDrivingPage("view-1", fallback as never)).toBe(second);
	});

	it("returns the fallback and never throws when the resolver throws", async () => {
		_setPageResolverForTest(async () => {
			throw new Error("boom");
		});

		const page = await resolveDrivingPage("view-1", fallback as never);
		expect(page).toBe(fallback);
	});

	it("treats an isClosed() that throws as not-live and returns the fallback", async () => {
		const flaky = {
			tag: "flaky",
			isClosed: () => {
				throw new Error("handle detached");
			},
		};
		_setPageResolverForTest(async () => flaky as never);

		const page = await resolveDrivingPage("view-1", fallback as never);
		expect(page).toBe(fallback);
	});
});

describe("realDrivingPage", () => {
	it("returns the live real Page when the resolver yields one", async () => {
		const real = fakePage("real");
		_setPageResolverForTest(async () => real as never);

		expect(await realDrivingPage("view-1")).toBe(real);
	});

	it("returns null when the resolver yields null (no CDP / not found)", async () => {
		_setPageResolverForTest(async () => null);

		expect(await realDrivingPage("view-1")).toBeNull();
	});

	it("returns null when the resolver yields an already-closed page (never a stale handle)", async () => {
		_setPageResolverForTest(async () => fakePage("closed", true) as never);

		expect(await realDrivingPage("view-1")).toBeNull();
	});

	it("returns null and never throws when the resolver throws", async () => {
		_setPageResolverForTest(async () => {
			throw new Error("boom");
		});

		expect(await realDrivingPage("view-1")).toBeNull();
	});
});

describe("invalidateDrivingPage", () => {
	it("drops the cache so the next resolve re-resolves", async () => {
		const real = fakePage("real");
		let calls = 0;
		_setPageResolverForTest(async () => {
			calls += 1;
			return real as never;
		});

		expect(await resolveDrivingPage("view-1", fallback as never)).toBe(real);
		expect(calls).toBe(1);

		// Cached: a second resolve serves the live page without re-resolving.
		expect(await resolveDrivingPage("view-1", fallback as never)).toBe(real);
		expect(calls).toBe(1);

		// After explicit teardown the next resolve must hit the resolver again.
		invalidateDrivingPage("view-1");
		expect(await resolveDrivingPage("view-1", fallback as never)).toBe(real);
		expect(calls).toBe(2);
	});
});
