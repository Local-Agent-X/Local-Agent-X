/**
 * page-egress-taint — the taint-aware, payload-inspecting gate for the in-app
 * browser's OWN network requests (the page's fetch/XHR/sendBeacon/img-beacon/
 * form-POST/top-level-navigation), not the agent's tool calls.
 *
 * WHY THIS EXISTS: an earlier defense stamped a same-site CSP on every page to
 * deny cross-origin egress by construction. It broke every multi-CDN site
 * (x.com's JS lives on abs.twimg.com, google's on gstatic.com) because CSP can
 * only discriminate by DOMAIN, and img-src/connect-src are BOTH the rendering
 * channels AND the exfil channels — you cannot tell "load Twitter's CDN" from
 * "beacon a secret to a lookalike CDN" by domain alone. It was reverted.
 *
 * The distinguishing signal is not the destination domain, it is WHETHER THE
 * REQUEST CARRIES PROTECTED BYTES. This gate keys on exactly that:
 *
 *   BLOCK a request iff it is CROSS-registrable-domain from the page's own
 *   origin AND its URL or body actually contains this session's canary token or
 *   bytes from a tainted (agent-read-sensitive) source.
 *
 * Consequences that make it render-safe:
 *   - A CDN asset read (twimg.com JS, gstatic CSS, an analytics beacon) carries
 *     no canary and no tainted bytes → ALLOWED. Rendering is untouched.
 *   - A first-party (same registrable domain) request carrying the page's own
 *     data → ALLOWED. A page legitimately POSTs its own data to its own API.
 *   - A cross-domain POST/GET whose payload overlaps a tainted fingerprint, or
 *     carries a canary → BLOCKED. That is the exfil the reverted CSP aimed at,
 *     now caught WITHOUT a blanket same-site block.
 *
 * It deliberately does NOT use the tool-layer's sticky "presence floor"
 * (checkEgressTaint): that blocks ALL egress once a session is tainted, which
 * would re-break rendering on any page after the agent reads one sensitive file.
 * We use findTaintInPayload — POSITIVE OVERLAP ONLY — so only requests that
 * genuinely carry the tainted bytes are stopped.
 *
 * SCOPE / RESIDUALS (honest):
 *   - Structured-secret shape scanning is intentionally OMITTED: a cross-domain
 *     request carrying a JWT/API-key shape is normal on the open web (every
 *     OAuth redirect, every Bearer-token API call), so blanket-blocking those
 *     would break auth. Only session-specific taint/canary — which a normal
 *     site's traffic never contains — is used, giving a near-zero false-positive
 *     rate.
 *   - Only bytes the agent actually READ via a tool are tainted. Page-resident
 *     data the agent never touched is outside this model (that was the blanket
 *     CSP's job, which is irreconcilable with multi-CDN rendering).
 *   - Header-only and DNS-label side channels are not covered here.
 *   - Pure and side-effect-free: reads the session taint/canary registries,
 *     mutates nothing. The enforcing caller records the canary audit exactly
 *     once (mirrors tool-execution/egress-gates.ts probe/enforce split).
 */

import { findTaintInPayload } from "../data-lineage/index.js";
import { checkCanariesInPayload } from "../threat/canaries.js";
import { registrableDomain } from "./csp-policy.js";

export interface PageEgressRequest {
	/** The outbound request URL (query/path may carry GET-beacon exfil). */
	url: string;
	/** Requesting page/frame origin URL, when known. */
	pageUrl?: string;
	/** Decoded outbound body bytes (POST/PUT/PATCH), when present. */
	body?: string;
}

export type PageEgressVerdict =
	| { allowed: true }
	| {
			allowed: false;
			/** Which enforcement layer fired (for logs/audit). */
			layer: "canary" | "data-lineage";
			/** Human reason (host-only — never echoes the payload/secret). */
			reason: string;
			/** True when a canary tripped — the caller owes the one-time audit. */
			canary: boolean;
	  };

/** Host for a URL, or "" when unparseable — used for reason text only (never
 *  the full URL, which could carry the exfiltrated bytes). */
function hostOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return "";
	}
}

/**
 * True when `url` targets a DIFFERENT registrable domain than the page it is
 * issued from — the only requests a page-egress exfil could ride. Fail-SAFE:
 * an unknown/opaque page origin (about:blank, first navigation, unparseable) is
 * treated as cross-site so the payload is scanned rather than waved through. A
 * request URL that won't parse returns false — the URL SSRF policy that runs
 * before this gate already rejects it, so there is nothing to scan.
 */
export function isCrossSiteHop(url: string, pageUrl: string | undefined): boolean {
	const reqHost = hostOf(url);
	if (!reqHost) return false; // unparseable request URL — URL policy handles it.
	if (!pageUrl) return true; // no first-party origin known → scan (fail-safe).
	const pageHost = hostOf(pageUrl);
	if (!pageHost) return true; // opaque page origin (about:blank) → scan.
	// registrableDomain is null for IP/localhost/single-label → pin to exact host.
	const reqReg = registrableDomain(reqHost) ?? reqHost.toLowerCase();
	const pageReg = registrableDomain(pageHost) ?? pageHost.toLowerCase();
	return reqReg !== pageReg;
}

/**
 * Positive-overlap page-egress scan for `sessionId`. Returns a block verdict
 * ONLY when a cross-registrable-domain request's URL/body actually carries the
 * session's canary or tainted bytes. Same-site hops and clean payloads pass.
 * Pure: the caller records the canary audit on a canary verdict.
 */
export function scanPageEgress(sessionId: string, req: PageEgressRequest): PageEgressVerdict {
	// First-party hops are always allowed — a page talking to its own domain is
	// not exfil, and this is what keeps a legit SPA (and multi-CDN rendering)
	// working. Only cross-domain hops are candidates.
	if (!isCrossSiteHop(req.url, req.pageUrl)) return { allowed: true };

	// Scan the URL (GET-beacon path/query) plus any body (POST payload). Both are
	// run through the fingerprint decoders inside the primitives, so a base64/hex/
	// percent-encoded copy of the tainted bytes still matches.
	const scanText = req.body ? `${req.url}\n${req.body}` : req.url;
	const dest = hostOf(req.url) || "an external host";

	// Canary: deterministic proof of protected-context exfiltration. A normal
	// site's traffic never contains the session canary, so this is near-zero-FP.
	if (checkCanariesInPayload(sessionId, scanText)) {
		return {
			allowed: false,
			layer: "canary",
			canary: true,
			reason: `a session canary token appears in a cross-domain request to ${dest} — definitive exfiltration of protected context`,
		};
	}

	// Tainted-byte overlap: the payload carries bytes the agent read from a
	// sensitive source this session (positive overlap, not the sticky floor).
	const taint = findTaintInPayload(sessionId, scanText);
	if (taint.length > 0) {
		const named = [...new Set(taint.map((t) => `${t.source}:${t.target.slice(0, 40)}`))].join(", ");
		return {
			allowed: false,
			layer: "data-lineage",
			canary: false,
			reason: `a cross-domain request to ${dest} carries bytes from tainted source(s): ${named}`,
		};
	}

	return { allowed: true };
}
