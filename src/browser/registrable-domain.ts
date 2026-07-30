import { getDomain } from "tldts";

/**
 * Derive eTLD+1 using the Public Suffix List, including private multi-tenant
 * suffixes such as vercel.app and herokuapp.com.
 */
export function registrableDomain(hostname: string): string | null {
	const domain = getDomain(hostname, { allowPrivateDomains: true });
	return domain || null;
}
