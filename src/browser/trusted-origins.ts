/**
 * Trusted-origin registry — the GENERAL mechanism supervised browser mode
 * consults to decide whether an automated `browser.evaluate` may run without a
 * confirmation prompt.
 *
 * This is DATA + one predicate, deliberately NOT a pile of `if (host === …)`
 * branches. Enforcement (src/tool-execution/pre-dispatch.ts) never names a
 * site: it asks isTrustedOrigin(url). Growing the trust set is an
 * addTrustedOrigin() call (or, later, a settings-backed list), never a code
 * change in the gate.
 *
 * The default set is the social / composer origins automations actually drive.
 * They are all REGISTRABLE domains (eTLD+1), so a suffix match against them is
 * eTLD+1-correct for the defaults: it trusts every subdomain (mobile.x.com) and
 * rejects look-alikes (x.com.evil.com) without a public-suffix table.
 *
 * NOTE(csp-policy convergence): src/browser/csp-policy.ts exports a
 * public-suffix-aware `registrableDomain` (eTLD+1) helper. The local
 * suffix-compare below is eTLD+1-correct for the registrable-domain default set,
 * so it is retained as-is; converge onto the shared helper (DRY) only if a
 * future trusted entry is a bare public suffix or a non-registrable host.
 */

/** The out-of-box trusted origins — registrable domains (eTLD+1). Frozen so no
 *  caller can mutate the defaults; growth goes through addTrustedOrigin. */
export const DEFAULT_TRUSTED_ORIGINS: readonly string[] = Object.freeze([
	"x.com",
	"twitter.com",
	"instagram.com",
	"facebook.com",
	"tiktok.com",
	"linkedin.com",
]);

/** Runtime-added trusted registrable domains (extension point). */
const extraTrusted = new Set<string>();

/** Normalize a user-supplied domain to a bare, lowercase registrable host:
 *  strip a scheme, any path, a leading "www.", and trailing/leading dots. */
function normalizeDomain(input: string): string {
	let host = input.trim().toLowerCase();
	// Accept a full URL, a "host/path", or a bare domain.
	try {
		if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) host = new URL(host).hostname;
	} catch {
		/* fall through — treat as a bare host */
	}
	host = host.split("/")[0]!;
	host = host.replace(/^\.+/, "").replace(/\.+$/, "");
	host = host.replace(/^www\./, "");
	return host;
}

/** Extend the trusted set at runtime. No-op for empty/invalid input. */
export function addTrustedOrigin(domain: string): void {
	const host = normalizeDomain(domain);
	if (host) extraTrusted.add(host);
}

/** The live trusted set (defaults + runtime additions). */
export function trustedOrigins(): string[] {
	return [...DEFAULT_TRUSTED_ORIGINS, ...extraTrusted];
}

/** Test-only: drop runtime additions, restoring the frozen default set. */
export function _resetTrustedOrigins(): void {
	extraTrusted.clear();
}

/** Parse a URL to its lowercased hostname (no trailing dot). null when the
 *  input is not a parseable absolute URL — an UNKNOWABLE origin, which callers
 *  in supervised mode treat as NOT trusted (fail safe toward approval). */
function hostnameOf(url: string): string | null {
	try {
		return new URL(url).hostname.toLowerCase().replace(/\.+$/, "");
	} catch {
		return null;
	}
}

/**
 * Is this URL's origin trusted for autonomous browser.evaluate?
 *
 * eTLD+1-aware for the default set: a host is trusted when it equals a trusted
 * registrable domain OR is a subdomain of one (`host.endsWith("." + d)`). That
 * accepts mobile.x.com and rejects x.com.evil.com (which ends with "x.com" but
 * not ".x.com"). An unparseable/empty URL is never trusted.
 */
export function isTrustedOrigin(url: string): boolean {
	const host = hostnameOf(url);
	if (!host) return false;
	for (const d of trustedOrigins()) {
		if (host === d || host.endsWith("." + d)) return true;
	}
	return false;
}
