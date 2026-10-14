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

/** Why a secret may go to a destination — the ladder every emitter consults. */
export type DestinationDecision = "origin" | "session" | "pre_bless" | "approved" | "ask";

export interface DestinationRecord {
  origin?: string;
  createdBySession?: string;
  approvedDestinations?: ReadonlyArray<{ origin: string }>;
}

/**
 * The ladder, in order. The session and pre-bless rungs are site-conditioned,
 * as the browser fill gate always had them: a secret captured this session
 * may go to its own site without a card, not to a host the model chose on
 * another site. A secret with no recorded origin (saved by name only) has no
 * site to condition on, so those two rungs apply anywhere for it.
 */
export function decideDestination(
  entry: DestinationRecord,
  key: string,
  ctx: { sessionId?: string; preBlessed: boolean },
): DestinationDecision {
  if (entry.origin && entry.origin === key) return "origin";
  const ownSite = !entry.origin || sameDestinationSite(key, entry.origin);
  if (ownSite && ctx.sessionId && entry.createdBySession === ctx.sessionId) return "session";
  if (ownSite && ctx.preBlessed) return "pre_bless";
  if (entry.approvedDestinations?.some((a) => a.origin === key)) return "approved";
  return "ask";
}
