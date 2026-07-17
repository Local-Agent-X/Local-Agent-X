import { getDomain } from "tldts";

/**
 * csp-policy — the backend-agnostic Content-Security-Policy builder for the
 * in-app agent browser, plus the eTLD+1 helper shared with the page-egress
 * taint gate.
 *
 * HISTORY — WHY THIS IS NARROW NOW:
 * An earlier design stamped a DEFAULT-DENY, same-site-scoped CSP (script / style
 * / img / font / connect all pinned to the page's OWN registrable domain) to
 * deny the cross-origin exfil class by construction. That is irreconcilable with
 * modern multi-CDN sites — x.com serves its JS/CSS from abs.twimg.com, google
 * from gstatic.com, instagram from cdninstagram.com — so pages rendered unstyled
 * or did not boot at all (the SPA's own CDN JS was blocked). It was reverted
 * (commit cc52c99e). CSP cannot separate "load Twitter's CDN" from "beacon a
 * secret to a lookalike CDN" by domain, because img-src / connect-src are BOTH
 * the rendering channels AND the exfil channels for an arbitrary site.
 *
 * The exfil class is now covered where it can be done WITHOUT breaking
 * rendering: a taint-aware, payload-inspecting gate at the per-hop request
 * evaluator (page-egress-taint.ts) that blocks only a cross-registrable-domain
 * request whose URL/body actually carries tainted or canary bytes for the owning
 * session. A CDN asset read carries none, so it is never touched; the signal is
 * TAINT, not domain.
 *
 * What survives HERE is the set of hardening directives that add real value at
 * ZERO rendering cost — they do not gate where a page loads its own subresources
 * from, so no multi-CDN site is affected:
 *   - object-src 'none'      : no <object>/<embed>/plugin sinks (Flash is dead).
 *   - base-uri 'self'        : a <base href> may only point same-origin, so an
 *                              injected <base> can't silently repoint every
 *                              relative URL (incl. script src) to an attacker.
 *                              'self' (not 'none') preserves the common
 *                              same-origin `<base href="/">`; a cross-origin-CDN
 *                              <base> (rare) is the one small compat surface.
 *   - frame-ancestors 'none' : nobody may frame the agent view (anti-clickjack).
 *                              MUST be stamped on the TOP-LEVEL document only — on
 *                              an iframe it makes Chromium refuse the embed
 *                              (Stripe/OAuth/maps). csp-inject.ts (CDP) and the
 *                              mainFrame-only guard in browser-partition.ts
 *                              (in-app) both enforce that.
 *
 * This policy sets NO default-src and NO fetch directives, so every subresource
 * / connect / script / style load stays at the browser default (allowed) and
 * multi-CDN sites render normally.
 */

/**
 * The hardening-only agent CSP header value. URL-independent by construction —
 * the fetch-scoping that once depended on the page's domain is gone (see header).
 *
 * The desktop in-app backend cannot import this module (separate CJS project),
 * so it mirrors this exact string in a local constant
 * (AGENT_HARDENING_CSP in desktop/src/browser-partition.ts). Because the policy
 * is now a fixed 3-directive literal with no logic, there is nothing to drift;
 * keep the two in sync if this ever changes.
 */
export function buildAgentCsp(): string {
	return "object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
}

/**
 * Derive the registrable domain (eTLD+1) for a hostname, or null when the
 * concept does not apply. Shared by the page-egress taint gate to decide whether
 * a request is cross-registrable-domain (a candidate exfil hop) or first-party.
 *
 * eTLD+1 is resolved by the `tldts` library against the full Public Suffix
 * List — INCLUDING the PSL PRIVATE section (allowPrivateDomains: true). That
 * flag is security-load-bearing: multi-tenant SaaS suffixes registered in the
 * PSL private section (herokuapp.com, amazonaws.com, vercel.app, pages.dev,
 * web.app, blogspot.com, azurewebsites.net, netlify.app, onrender.com,
 * workers.dev, cloudfront.net, firebaseapp.com, ...) are gTLDs, so a naive
 * "last two labels" heuristic would collapse victim.herokuapp.com to the bare
 * suffix herokuapp.com and treat a DIFFERENT tenant (attacker.herokuapp.com) as
 * same-site. With allowPrivateDomains the private suffix is treated as a public
 * suffix, so getDomain("victim.herokuapp.com") returns "victim.herokuapp.com"
 * and a different tenant is correctly cross-domain.
 *
 * tldts returns null (→ this returns null) for inputs with no registrable
 * domain: IP literals, localhost / single-label hosts, bare public suffixes
 * (com.pl, co.uk), bare private suffixes (herokuapp.com), and unparseable input
 * (about:blank's empty host, garbage).
 *
 * tldts is the single source of truth for the eTLD+1 boundary; there is no
 * hand-rolled suffix list in this file to drift from the PSL.
 */
export function registrableDomain(hostname: string): string | null {
	const reg = getDomain(hostname, { allowPrivateDomains: true });
	return reg || null;
}
