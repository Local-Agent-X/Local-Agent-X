/**
 * navigateInAppView — the in-app browser's navigate driver, split out of
 * ElectronInAppBackend so the backend stays under the file-size cap and the
 * native-vs-bridge decision lives in one testable leaf.
 *
 * Native driving when a REAL CDP-backed Page exists for the view (page.goto via
 * page-ops.gotoPage), the desktop bridge navigate otherwise. Both paths return
 * the same BrowserNavigateResult, so the backend's report formatting is
 * driver-agnostic. Egress enrichment is likewise driver-agnostic: a denied
 * navigation surfaces as ERR_BLOCKED_BY_CLIENT on either path and is rewrapped
 * by enrichBlockedNavigation into the policy reason + recovery.
 *
 * The title read lives HERE (native path only) — deliberately NOT inside
 * gotoPage, which the external-Chrome manager also shares and which reads its
 * title later, after its own load-settle waits. On this native path the bridge
 * has no title to hand back, so we read it straight off the real Page; a
 * sensitive landed URL is withheld (title left "") so a vault/recovery page's
 * title is never fetched. DOM observation stays in the isolated world elsewhere
 * (in-app-observe.ts) — this leaf only drives the top-level navigation.
 *
 * SECURITY: the native goto rides the view partition's NORMAL session network
 * stack — this leaf adds NO page.route() / context.route() / Fetch.enable
 * interception and NEVER creates a browser context — so the partition
 * webRequest egress guard fires on the navigation exactly as it does for a
 * user load.
 */

import { realDrivingPage } from "./in-app-driving-page.js";
import { gotoPage } from "./page-ops.js";
import { browserNavigate, type BrowserNavigateResult } from "./bridge-client.js";
import { enrichBlockedNavigation } from "./bridge-egress.js";
import { sensitivePageStub } from "./guards.js";

/**
 * Drive a single navigation for the in-app view: native page.goto when a real
 * Page is resolvable, else the desktop bridge. Throws the egress-ENRICHED error
 * (identical for both paths) when the navigation is blocked; any other failure
 * propagates unchanged.
 */
export async function navigateInAppView(
	viewId: string,
	url: string,
	sessionId: string,
): Promise<BrowserNavigateResult> {
	const real = await realDrivingPage(viewId);
	try {
		if (real) {
			// Native driving: page.goto for the raw url/status (page-ops.gotoPage),
			// then read the title off the real Page here — withheld when sensitive.
			const nav = await gotoPage(real, url);
			const title = sensitivePageStub(nav.url) ? "" : await real.title();
			return { url: nav.url, title, ...(typeof nav.status === "number" ? { status: nav.status } : {}) };
		}
		// Bridge fallback: the desktop returns url/title/status for the view.
		return await browserNavigate(viewId, url, sessionId);
	} catch (e) {
		// SAME enrichment for both paths: ERR_BLOCKED_BY_CLIENT → policy reason.
		throw enrichBlockedNavigation(e, url, viewId);
	}
}
