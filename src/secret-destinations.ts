// Where a vault secret may be sent (ADR 0005): the one key shape and the one
// ladder. Pure; the store (secrets.ts) owns the records and calls in here.
import { registrableDomain } from "./browser/registrable-domain.js";

/** Two destinations of one site: the same registrable domain, whatever the
 *  scheme — a password captured on app.fastmail.com belongs to
 *  smtp.fastmail.com too. (The browser's sameSite is https-only on purpose.) */
export function sameDestinationSite(a: string, b: string): boolean {
  try {
    const site = registrableDomain(new URL(a).hostname);
    return !!site && site === registrableDomain(new URL(b).hostname);
  } catch {
    return false;
  }
}

/** The one producer of destination keys: a URL's origin, or for a mail
 *  endpoint (`smtp://host:port`) the lowercased host with its port. */
export function normalizeDestination(input: string): string | undefined {
  let url: URL;
  try { url = new URL(String(input || "").trim()); } catch { return undefined; }
  if (url.origin !== "null") return url.origin;
  if (!url.hostname) return undefined;
  return `${url.protocol}//${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}`;
}

/**
 * The saved origin itself, or a host under it: the same scheme and port, and
 * the destination's host is the saved host or a subdomain of it. A key saved
 * for https://supabase.com may go to https://api.supabase.com; one saved for
 * https://api.example.com may not go to https://example.com (the parent), nor
 * one saved for https://a.supabase.co to https://b.supabase.co (a neighbour).
 * A saved host that is itself a public suffix (github.io) or an address has
 * nothing under it that its owner holds, so only the host itself counts.
 */
export function isUnderOrigin(saved: string, key: string): boolean {
  try {
    const s = new URL(saved);
    const k = new URL(key);
    if (s.protocol !== k.protocol || s.port !== k.port) return false;
    const savedHost = s.hostname.toLowerCase();
    const host = k.hostname.toLowerCase();
    if (host === savedHost) return true;
    return host.endsWith(`.${savedHost}`) && !!registrableDomain(savedHost);
  } catch {
    return false;
  }
}

/** Why a secret may go to a destination — the ladder every emitter consults. */
export type DestinationDecision = "origin" | "session" | "pre_bless" | "approved" | "ask";

/** What the ladder is judged with, beyond the record and the destination. */
export interface DestinationContext {
  sessionId?: string;
  preBlessed: boolean;
  /** The origin rung takes only the saved origin itself, never a host under
   *  it. The browser credential fill asks for this: a password typed into a
   *  look-alike subdomain page is the phishing case, which an API call to a
   *  provider's own subdomain is not. */
  exactOrigin?: boolean;
}

export interface DestinationRecord {
  origin?: string;
  createdBySession?: string;
  approvedDestinations?: ReadonlyArray<{ origin: string }>;
}

/**
 * The ladder, in order. The origin rung takes the saved origin or a host under
 * it (isUnderOrigin), unless the caller asks for the exact origin. The session
 * and pre-bless rungs are site-conditioned, as the browser fill gate always
 * had them: a secret captured this session may go to its own site without a
 * card, not to a host the model chose on another site. A secret with no
 * recorded origin (saved by name only) has no site to condition on, so those
 * two rungs apply anywhere for it.
 */
export function decideDestination(
  entry: DestinationRecord,
  key: string,
  ctx: DestinationContext,
): DestinationDecision {
  if (entry.origin && (entry.origin === key || (!ctx.exactOrigin && isUnderOrigin(entry.origin, key)))) return "origin";
  const ownSite = !entry.origin || sameDestinationSite(key, entry.origin);
  if (ownSite && ctx.sessionId && entry.createdBySession === ctx.sessionId) return "session";
  if (ownSite && ctx.preBlessed) return "pre_bless";
  if (entry.approvedDestinations?.some((a) => a.origin === key)) return "approved";
  return "ask";
}
