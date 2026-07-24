/**
 * Real-Page provider leaf for the in-app Electron browser.
 *
 * Given a viewId and a fallback Page (the isolated-world BridgeObservePage
 * adapter the in-app backend already holds), this returns the REAL Playwright
 * Page for that view when the embedded browser's CDP endpoint is connected, and
 * the fallback otherwise. The real Page carries full-fidelity primitives the
 * bridge adapter can only approximate; callers that opt into it get those for
 * free, and silently degrade to the adapter when CDP is absent (dev /
 * no-desktop / connect-failed).
 *
 * The real Page comes from getPageForView (electron-cdp.ts), which returns null
 * in exactly those degraded cases and ONLY ever hands back an EXISTING
 * WebContentsView Page (never a freshly created context/page). Resolution is
 * cached per viewId, self-healing (a closed/stale real Page is dropped and
 * re-resolved on the next call), and NEVER throws — any failure yields the
 * fallback. This chunk only provides the seam; wiring a caller onto it is a
 * later chunk.
 *
 * SECURITY — invariants that keep the fail-closed egress guarantee intact once
 * a real Page is driven (from the egress-coexistence spike). They bind this
 * leaf AND every future consumer:
 *   - NEVER call page.route() / context.route(), and NEVER enable the CDP
 *     `Fetch` domain, on the driving Page. Playwright implements route() via
 *     Fetch.enable, which can bypass the partition webRequest egress guard.
 *     This leaf adds no routing/interception of any kind.
 *   - NEVER create a browser context (browser.newContext() /
 *     Target.createBrowserContext). A fresh context is an UNHARDENED session
 *     with no egress guard. Only ever reach a Page via getPageForView, which
 *     returns an EXISTING hardened-partition WebContentsView Page.
 *   - The window.name === viewId marker is the id->Page contract getPageForView
 *     relies on; nothing here touches it.
 */
import type { Page } from "playwright";
import { createLogger } from "../logger.js";
import { getPageForView } from "./electron-cdp.js";

const logger = createLogger("browser.in-app-driving-page");

/**
 * Resolves the real Playwright Page for a viewId, or null when CDP is absent /
 * the view is not found. Injectable so tests can supply a fake Page and never
 * open a real socket — mirrors electron-cdp.ts's module-level connector-setter
 * seam. The default is getPageForView, which only ever returns EXISTING hardened
 * pages (see SECURITY above).
 */
export type PageResolver = (viewId: string) => Promise<Page | null>;

let resolver: PageResolver = getPageForView;

// One cached real Page per view. Only NON-closed real Pages are ever cached —
// the fallback is never stored, so a later CDP connect can upgrade a view that
// previously resolved to the fallback.
const cache = new Map<string, Page>();

/**
 * True when the Page is present and reports itself not-closed. isClosed() is
 * wrapped: a throw from a torn-down handle counts as not-live, so a stale Page
 * is dropped rather than handed back.
 */
function isLive(page: Page): boolean {
	try {
		return !page.isClosed();
	} catch {
		return false;
	}
}

/**
 * The real CDP-backed Page for this view, or null when CDP is absent / not
 * found. Cached + self-healing like resolveDrivingPage, but returns null instead
 * of a fallback — for DRIVING primitives (goto/input) that only work on a real
 * Page. Never throws: any failure yields null so the caller degrades cleanly.
 */
export async function realDrivingPage(viewId: string): Promise<Page | null> {
	try {
		// Serve a still-live cached real Page without a round-trip.
		const cached = cache.get(viewId);
		if (cached) {
			if (isLive(cached)) return cached;
			// A recreated view reuses its viewId with a new underlying Page; the
			// old handle is closed. Drop it and re-resolve below — this is the
			// self-heal that makes external invalidation optional.
			cache.delete(viewId);
		}

		const page = await resolver(viewId);
		if (page && isLive(page)) {
			cache.set(viewId, page);
			return page;
		}
		// null (no CDP / not found) or a page that is somehow already closed —
		// no real Page. Never cache the (absent) result.
		return null;
	} catch (err) {
		logger.warn(`realDrivingPage(${viewId}) failed: ${(err as Error).message}`);
		return null;
	}
}

/**
 * Return the real CDP-backed Page for this view if the embedded browser's CDP
 * endpoint is connected and a live Page exists; otherwise the passed-in fallback
 * (the isolated-world bridge adapter). Cached per viewId, self-healing, never
 * throws — shares realDrivingPage's ONE cache + liveness path.
 */
export async function resolveDrivingPage(viewId: string, fallback: Page): Promise<Page> {
	return (await realDrivingPage(viewId)) ?? fallback;
}

/**
 * Drop any cached real Page for this view. Call when a view is torn down or
 * recreated. Liveness self-heal already handles the common recreate case, but
 * explicit teardown by a later chunk should not depend on the next resolve to
 * notice.
 */
export function invalidateDrivingPage(viewId: string): void {
	cache.delete(viewId);
}

/**
 * Test seam: override the getPageForView resolver (pass null to restore the
 * default). Also clears the cache so each test starts clean — mirrors the reset
 * side-effect of electron-cdp.ts's _setConnectorForTest and cdp-network.ts's
 * _setPageProviderForTest.
 */
export function _setPageResolverForTest(fn: PageResolver | null): void {
	resolver = fn ?? getPageForView;
	cache.clear();
}
