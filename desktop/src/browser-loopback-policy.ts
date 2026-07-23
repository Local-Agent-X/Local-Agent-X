/**
 * Loopback egress policy for USER-driven in-app browser views.
 *
 * The agent egress policy (server-side network-policy.ts, wired into the
 * partition stack via setEgressEvaluator) SSRF-blocks loopback ports other
 * than LAX's own and discovered local-runtime ports. That posture is correct
 * for AGENT-driven views — a prompt-injected page must not pivot the agent
 * into internal services — but the user's OWN tabs are their browser:
 * navigating to a local service they run (a ComfyUI on :8188, a dev server
 * on :3000) must work the way it does in Chrome. Without this carve-out the
 * pane sits silently white while every request is cancelled.
 *
 * The rule mirrors Chromium's Private Network Access semantics:
 *   - applies only to requests attributed to a USER view (agentDriven:false,
 *     resolved via the trust resolver browser-views registers);
 *   - the target must be a LITERAL loopback host (127.0.0.1 / localhost /
 *     ::1) — never a resolvable hostname, preserving DNS-rebinding safety;
 *   - allowed when the request is a top-level (mainFrame) navigation — the
 *     user deliberately going somewhere — or when the request's INITIATOR is
 *     itself a loopback origin (a local page loading its own assets and
 *     talking to same-machine APIs/WebSockets).
 *
 * What stays closed: an INTERNET page in a user tab still cannot touch
 * loopback (its initiator is non-loopback and its subresource requests are
 * not mainFrame navigations), and AGENT views — including views the trust
 * resolver cannot attribute (popups, unknown webContents) and user views the
 * agent currently ADOPTED via switch_tab (trust flips to "agent" while
 * adopted; see browser-download-routing.viewTrust) — remain governed by the
 * strict server-side policy. The cross-origin SSRF invariant the
 * agent policy enforces is intact; only the user's deliberate local browsing
 * is opened.
 *
 * Pure module (no electron imports) so the policy is unit-testable.
 */

export type ViewTrust = "user" | "agent";

export interface LoopbackRequestDetails {
	url: string;
	resourceType: string;
	/** Origin that issued the request; absent for browser-initiated loads. */
	initiator?: string;
	/** Id of the webContents the request belongs to; absent for some
	 *  session-level requests. */
	webContentsId?: number;
}

export function isLoopbackHostname(hostname: string): boolean {
	const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

const LOOPBACK_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);

export function shouldAllowUserLoopback(
	details: LoopbackRequestDetails,
	resolveTrust: (webContentsId: number) => ViewTrust | null,
): boolean {
	let target: URL;
	try {
		target = new URL(details.url);
	} catch {
		return false;
	}
	if (!LOOPBACK_SCHEMES.has(target.protocol)) return false;
	if (!isLoopbackHostname(target.hostname)) return false;
	// Unattributable request (no webContents, or one the pool doesn't know —
	// e.g. a popup) → not ours to open; the strict egress evaluator decides.
	if (details.webContentsId === undefined) return false;
	if (resolveTrust(details.webContentsId) !== "user") return false;
	// The user navigating somewhere is always theirs to do.
	if (details.resourceType === "mainFrame") return true;
	// Subresources/XHR/WebSockets: only when the REQUESTING page is itself a
	// loopback origin. An internet page's initiator fails this check.
	if (!details.initiator) return false;
	try {
		return isLoopbackHostname(new URL(details.initiator).hostname);
	} catch {
		return false;
	}
}
