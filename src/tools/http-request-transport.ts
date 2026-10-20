// How http_request meets the wire: the headers a request starts with, and the
// fetch that follows redirects under the egress and secret rules.
import { fetch as undiciFetch } from "undici";
import type { RequestInit as UndiciRequestInit, Response } from "undici";
import {
  assertRedirectEgressAllowed, assertLiteralIpEgressAllowed, isCredentialHeader,
  BROWSER_USER_AGENT, reachesOwnServer, selfCallAuthHeader,
} from "./web-egress.js";

export interface StartingHeaders {
  /** The headers sent before the model's own are added (with secrets resolved). */
  headers: Record<string, string>;
  /** The model's headers, unresolved, minus any dropped ones. */
  modelHeaders: Array<[string, string]>;
  /** A self call authenticates as the agent (null for any other host). */
  selfAuth: Record<string, string> | null;
  /** What the result says about headers that were dropped, and its meta. */
  droppedNote: string;
  droppedMeta: { dropped_headers?: string[] };
}

/** The headers a request to `url` starts with: a browser user agent, and on a
 *  call to this server's own port the agent's credential in place of any the
 *  model wrote. */
export async function startingHeaders(url: string, given: unknown): Promise<StartingHeaders> {
  const headers: Record<string, string> = {
    "User-Agent": BROWSER_USER_AGENT,
  };
  // Loopback self-calls authenticate with the least-privilege internal agent
  // token (null for any external host, so it never leaks off-box). The
  // cross-origin redirect stripping below removes `authorization` if a self
  // redirect ever crosses to another origin.
  const selfAuth = await selfCallAuthHeader(url);
  if (selfAuth) Object.assign(headers, selfAuth);
  // A call to this server's own port runs as the agent: a credential header
  // the model wrote is dropped, because a known operator token would open
  // every route the agent role is denied (rbac-agent-denials.ts).
  const ownServer = await reachesOwnServer(url);
  const dropped: string[] = [];
  const modelHeaders: Array<[string, string]> = [];
  if (given && typeof given === "object") {
    for (const [key, value] of Object.entries(given as Record<string, unknown>)) {
      if (ownServer && isCredentialHeader(key)) {
        dropped.push(key);
        continue;
      }
      modelHeaders.push([String(key), String(value)]);
    }
  }
  const droppedNote = dropped.length === 0 ? "" :
    `\n\n[Dropped the ${dropped.join(", ")} header${dropped.length === 1 ? "" : "s"} you supplied: a request to ` +
    `Local Agent X's own server always runs as the agent, with the agent's own credential. If the server ` +
    `refuses the agent, its answer says where the user makes that change.]`;
  return { headers, modelHeaders, selfAuth, droppedNote, droppedMeta: dropped.length === 0 ? {} : { dropped_headers: dropped } };
}

/** A redirect to an origin where a bound secret is not approved: the hop is
 *  never sent, so neither the body nor a credential header reaches it. */
export class SecretRedirectStopped extends Error {
  constructor(readonly location: string, readonly names: string[]) {
    super(`Redirected to ${new URL(location).origin}, where ${names.map((n) => `{{${n}}}`).join(", ")} is not approved. The request was not followed there and nothing was re-sent.`);
  }
}

const MAX_REDIRECTS = 5;

/**
 * http_request's fetch: follows up to five redirects by hand, re-checking the
 * egress policy and the literal-IP SSRF guard on every hop, stripping
 * credential headers across origins, and stopping where a bound secret is not
 * approved (`unapprovedAt` names those secrets for a location). Returns the
 * final response and the URL it came from.
 */
export async function fetchFollowingRedirects(
  url: string,
  opts: UndiciRequestInit,
  headers: Record<string, string>,
  method: string,
  unapprovedAt: (location: string) => string[],
): Promise<{ res: Response; url: string }> {
  let currentUrl = url;
  // Pre-connect literal-IP SSRF check (the pinning dispatcher's
  // connect.lookup never fires for a literal IP).
  await assertLiteralIpEgressAllowed(currentUrl);
  let r = await undiciFetch(currentUrl, opts);
  let redirectCount = 0;

  while (r.status >= 300 && r.status < 400 && r.headers.get("location") && redirectCount < MAX_REDIRECTS) {
    const location = new URL(r.headers.get("location")!, currentUrl).toString();
    // Re-check the egress policy on a cross-host redirect (strict-mode
    // allowlist bypass via 302). Fail closed before following.
    assertRedirectEgressAllowed(currentUrl, location);
    // Literal-IP SSRF on every hop, same-host included (a 302 to a
    // literal private/metadata/NAT64/6to4 IP bypasses the dispatcher).
    await assertLiteralIpEgressAllowed(location);
    const origOrigin = new URL(currentUrl).origin;
    const newOrigin = new URL(location).origin;

    const redirectHeaders = { ...headers };
    if (origOrigin !== newOrigin) {
      // A bound secret follows a redirect only where the ladder allows
      // it; otherwise the hop is not sent (the model can re-issue the
      // request against the new host, which then asks).
      const unapproved = unapprovedAt(location);
      if (unapproved.length > 0) throw new SecretRedirectStopped(location, unapproved);
      for (const key of Object.keys(redirectHeaders)) {
        if (isCredentialHeader(key)) delete redirectHeaders[key];
      }
    }

    currentUrl = location;
    r = await undiciFetch(currentUrl, {
      ...opts,
      headers: redirectHeaders,
      body: r.status === 303 ? undefined : opts.body,
      method: r.status === 303 ? "GET" : method,
    });
    redirectCount++;
  }
  return { res: r, url: currentUrl };
}
