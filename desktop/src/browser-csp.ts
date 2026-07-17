/**
 * browser-csp — the Electron-backend (in-app WebContentsView) mirror of the
 * canonical agent-browser Content-Security-Policy builder.
 *
 * WHY A SECOND FILE: `desktop/src` is a SEPARATE CommonJS TS project (rootDir
 * src, include ["src/**"]) that cannot import from the root `../src` tree, so
 * the canonical builder at `src/browser/csp-policy.ts` is unreachable from here.
 * Rather than fork its logic freehand, this file mirrors it EXACTLY in directive
 * order and token set. Both builders resolve eTLD+1 through the same library
 * (`tldts` with `allowPrivateDomains`), so their output is byte-identical.
 * A shared golden-fixtures file (`src/browser/csp-fixtures.json`) is the contract:
 * this project's test asserts byte-exact equality against it. NOTE: the root
 * csp-policy test does NOT yet read the fixtures, and this desktop test is not
 * yet wired into CI — so the two-way lockstep is not enforced automatically.
 * The integration chunk (C8) wires both sides; until then, treat divergence as a
 * live risk and regenerate fixtures from the canonical builder on any change.
 *
 * REGISTRABLE-DOMAIN RESOLUTION: `tldts` (a real Public Suffix List) with
 * `allowPrivateDomains: true`, identical to csp-policy.ts. On PRIVATE suffixes
 * (herokuapp.com, amazonaws.com, vercel.app) this scopes the wildcard to the
 * tenant (`*.myapp.herokuapp.com`) instead of a cross-tenant `*.herokuapp.com`.
 *
 * Security invariant (identical to csp-policy.ts): default-deny, then re-open
 * only what a normal site needs, and scope every exfil-egress directive to the
 * page's own registrable domain. A script may execute but has no cross-origin
 * sink to send stolen data to.
 */

import { getDomain } from "tldts";

const INFRA_HOSTS: readonly string[] = Object.freeze([]);
const SAFE_SCHEME_SOURCES = Object.freeze({
	data: "data:",
	blob: "blob:",
});

/**
 * Same-site source list for a URL: 'self', the registrable domain, and all its
 * subdomains — with NO scheme prefix so it matches http/https AND ws/wss to that
 * domain. Hosts with no registrable domain (IP/localhost/single label) pin to
 * the exact host on any port. `allowPrivateDomains` is REQUIRED so private
 * suffixes (herokuapp.com, amazonaws.com, vercel.app) are treated as suffixes
 * and the wildcard is tenant-scoped, never cross-tenant.
 */
function siteSources(url: URL): string[] {
	const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (!host) return []; // about:blank and friends -> nothing but 'self'.
	const reg = getDomain(host, { allowPrivateDomains: true });
	if (reg) return [reg, `*.${reg}`];
	// Exact-host pin. Append ":*" so dev servers on non-default ports
	// (localhost:3000) keep working while remaining same-host.
	return [host, `${host}:*`];
}

function directive(name: string, sources: readonly string[]): string {
	// Collapse to unique, non-empty, order-preserving tokens.
	const seen = new Set<string>();
	const out: string[] = [];
	for (const s of sources) {
		if (!s || seen.has(s)) continue;
		seen.add(s);
		out.push(s);
	}
	return `${name} ${out.join(" ")}`.trim();
}

/**
 * Build the agent-browser CSP header VALUE for the currently-loaded URL. Mirrors
 * src/browser/csp-policy.ts:buildAgentCsp — identical directives and tokens.
 * Never throws: unparseable / opaque URLs fall back to the strictest posture.
 */
export function buildAgentCsp(currentUrl: string): string {
	let url: URL | null = null;
	try {
		url = new URL(currentUrl);
	} catch {
		url = null;
	}

	const site = url ? siteSources(url) : [];
	const infra = INFRA_HOSTS;
	const { data, blob } = SAFE_SCHEME_SOURCES;

	const sameSite = ["'self'", ...site, ...infra];

	const directives: string[] = [
		directive("default-src", ["'none'"]),
		// --- EXFIL-egress directives (the security-critical ones) ---
		directive("connect-src", sameSite),
		directive("form-action", sameSite),
		directive("img-src", [...sameSite, data, blob]),
		directive("media-src", [...sameSite, data, blob]),
		directive("font-src", [...sameSite, data]),
		directive("frame-src", sameSite),
		directive("child-src", sameSite),
		directive("worker-src", [...sameSite, blob]),
		directive("script-src", [...sameSite, "'unsafe-inline'", "'unsafe-eval'"]),
		directive("style-src", [...sameSite, "'unsafe-inline'"]),
		// --- Hardening directives ---
		directive("object-src", ["'none'"]),
		directive("base-uri", ["'none'"]),
		directive("frame-ancestors", ["'none'"]),
	];

	return directives.join("; ");
}

/** Chromium's resourceType for the top-level document response. */
const MAIN_FRAME_RESOURCE_TYPE = "mainFrame";
const CSP_HEADER = "Content-Security-Policy";

/**
 * Compute the responseHeaders to hand back from an onHeadersReceived handler for
 * a hardened agent partition. For the MAIN DOCUMENT response only, APPEND our
 * agent CSP as an ADDITIONAL Content-Security-Policy header — browsers enforce
 * the INTERSECTION of all CSP headers, so ours always applies and the page can
 * never loosen it. Every other response (sub-resources, which inherit the
 * document CSP) is returned untouched.
 *
 * Header keys are case-insensitive: if the site already sent a CSP header under
 * ANY casing, our value is appended to that same array (both are enforced);
 * otherwise a new header is added. All existing headers are preserved.
 *
 * Pure and side-effect-free so it is unit-testable without Electron.
 */
export function appendAgentCspHeaders(
	responseHeaders: Record<string, string[]> | undefined,
	resourceType: string,
	url: string,
): Record<string, string[]> {
	const headers: Record<string, string[]> = { ...(responseHeaders ?? {}) };
	if (resourceType !== MAIN_FRAME_RESOURCE_TYPE) return headers;

	const csp = buildAgentCsp(url);
	// Find an existing CSP header under any casing; append to it if present.
	let key = CSP_HEADER;
	for (const k of Object.keys(headers)) {
		if (k.toLowerCase() === "content-security-policy") {
			key = k;
			break;
		}
	}
	const existing = headers[key] ?? [];
	headers[key] = [...existing, csp];
	return headers;
}
