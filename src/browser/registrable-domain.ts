import { getDomain } from "tldts";

/**
 * Derive eTLD+1 using the Public Suffix List, including private multi-tenant
 * suffixes such as vercel.app and herokuapp.com.
 */
export function registrableDomain(hostname: string): string | null {
	const domain = getDomain(hostname, { allowPrivateDomains: true });
	return domain || null;
}

/** Two https origins (or URLs) of one site: the same registrable domain. */
export function sameSite(a: string, b: string): boolean {
	try {
		const ua = new URL(a);
		const ub = new URL(b);
		if (ua.protocol !== "https:" || ub.protocol !== "https:") return false;
		const site = registrableDomain(ua.hostname);
		return !!site && site === registrableDomain(ub.hostname);
	} catch {
		return false;
	}
}
