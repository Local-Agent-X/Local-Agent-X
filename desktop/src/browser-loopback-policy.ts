/**
 * Loopback egress policy for USER-driven in-app browser views.
 *
 * The agent egress policy (server-side network-policy.ts, wired into the
 * partition stack via setEgressEvaluator) SSRF-blocks loopback ports other
 * than LAX's own and discovered local-runtime ports. That strict posture is
 * the right default for cross-origin SSRF — a prompt-injected page must not
 * silently pivot into internal services — but it also breaks two legitimate
 * cases: the user navigating to a local service they run (a ComfyUI on :8188,
 * a dev server on :3000), and the AGENT loading the app it is building (served
 * on the LAX self-port, pulling its own dev-server chunks + HMR socket off a
 * loopback port). Without a carve-out the pane sits silently white while every
 * request is cancelled.
 *
 * The rule mirrors Chromium's Private Network Access semantics — the target
 * must be a LITERAL loopback host (127.0.0.1 / localhost / ::1), never a
 * resolvable hostname (preserving DNS-rebinding safety) — and splits by intent:
 *   - a top-level (mainFrame) navigation is allowed only for a USER view — the
 *     user deliberately going somewhere. Agent navigations stay strict.
 *   - a subresource / XHR / WebSocket is allowed for USER *and* AGENT views
 *     when the request's INITIATOR is itself a loopback origin — a local page
 *     loading its own same-machine assets.
 *
 * What stays closed: an INTERNET page (in any view) still cannot touch loopback
 * — its initiator is non-loopback and its subresources are not mainFrame
 * navigations — so the cross-origin SSRF invariant holds. Agent-view *navigation*
 * to an arbitrary loopback service stays under the strict server policy, and
 * views the trust resolver cannot attribute (popups, unknown webContents) fail
 * strict. Only same-machine local browsing and a local app loading itself open.
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

export function shouldAllowLocalLoopback(
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
	const trust = resolveTrust(details.webContentsId);
	if (trust === null) return false;
	// A top-level navigation to loopback is a deliberate "go here" for the USER's
	// own tabs. For an AGENT view it's allowed only when it originates FROM a
	// loopback page — i.e. a same-machine redirect, the LAX self-port handing the
	// document off to the app's own dev server. A hostile page redirecting the
	// agent into a loopback service has a non-loopback initiator and stays under
	// the strict server policy, so it can't SSRF-by-navigation.
	if (details.resourceType === "mainFrame") {
		return trust === "user" || initiatorIsLoopback(details.initiator);
	}
	// Subresources / XHR / WebSockets: allowed for BOTH user and agent views when
	// the REQUESTING page is itself a loopback origin — a local page loading its
	// own same-machine assets, dev-server chunks, and HMR socket. This is what
	// lets an agent BUILDING an app actually render it. An internet page's
	// initiator is non-loopback and stays blocked, so the cross-origin SSRF
	// invariant the agent policy enforces is intact.
	return initiatorIsLoopback(details.initiator);
}

function initiatorIsLoopback(initiator: string | undefined): boolean {
	if (!initiator) return false;
	try {
		return isLoopbackHostname(new URL(initiator).hostname);
	} catch {
		return false;
	}
}
