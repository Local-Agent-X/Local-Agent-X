// The one host-list matcher. A leaf (it imports only the host canonicalizer)
// so tool-policy can use it without importing the rest of the security layer,
// which already imports tool-policy.
import { canonicalizeHost } from "./ip-classification.js";

/**
 * Match a hostname against a host list (exact host or *.domain.com wildcard,
 * which also matches domain.com itself). The egress allowlist and tool-policy
 * allowedHosts/blockedHosts all decide here, on the canonical host (lowercase,
 * no brackets, no trailing dot, so `evil.com.` is `evil.com`).
 *
 * A broad wildcard (*.com, *.org: one label) is ignored by default, which is
 * right for a list that GRANTS reach. A list that REFUSES reach passes
 * `broadWildcards: true`, so "block *.ru" still blocks.
 */
export function matchEgressList(
  host: string,
  list: ReadonlySet<string>,
  { broadWildcards = false }: { broadWildcards?: boolean } = {},
): boolean {
  const h = canonicalizeHost(host);
  if (list.has(h)) return true;
  for (const d of list) {
    if (!d.startsWith("*.")) continue;
    const baseDomain = d.slice(2);
    if (!broadWildcards && baseDomain.split(".").length < 2) continue;
    if (h === baseDomain || h.endsWith("." + baseDomain)) return true;
  }
  return false;
}
