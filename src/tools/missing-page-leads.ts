/**
 * Leads for a page that returned 404/410.
 *
 * A bare "HTTP 404" tells the model nothing about where to go next, so it
 * retries the dead URL through every web tool it has (op-outcomes
 * moved-docs-page: web_fetch → browser → http_request ×3, then gave up) —
 * while the site's own index one level up links straight to the page's new
 * home. This gathers that evidence for the result instead: links on the 404
 * page itself, then the nearest parent pages on the SAME origin, ranked by how
 * closely they match the missing page's name.
 *
 * Same origin only: the web egress gate decides on host+port, never path, so a
 * parent path of an already-admitted URL is the same decision. Every fetch
 * goes through canonicalFetch (SSRF pin, per-hop redirect checks). Link text is
 * page content — callers must wrap the rendered note as external content.
 */

import { canonicalFetch } from "./web-egress.js";

export interface PageLead {
  url: string;
  text: string;
  foundOn: string;
  score: number;
}

export interface MissingPageLeads {
  leads: PageLead[];
  /** Pages that were read for links (the 404 page first when it had a body). */
  checked: string[];
}

/** Fetch an HTML page's body, or null when it isn't a readable HTML page. */
export type LeadPageFetcher = (url: string) => Promise<string | null>;

const MAX_ANCESTOR_FETCHES = 3;
const MAX_LEADS = 5;
const MAX_INDEX_LINKS = 8;
const MAX_LINK_TEXT = 80;
const MAX_BODY_CHARS = 500_000;

export function isMissingPageStatus(status: number): boolean {
  return status === 404 || status === 410;
}

/** Parent pages of `url` on the same origin, nearest first, ending at "/". */
export function ancestorUrls(url: string): string[] {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  const out: string[] = [];
  for (let n = segments.length - 1; n >= 0; n--) {
    out.push(`${parsed.origin}/${segments.slice(0, n).join("/")}`);
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

/** Same-origin `<a href>` links in `html`, resolved against `pageUrl`. */
export function extractSameOriginLinks(html: string, pageUrl: string): Array<{ url: string; text: string }> {
  const origin = new URL(pageUrl).origin;
  const seen = new Set<string>();
  const links: Array<{ url: string; text: string }> = [];
  for (const m of html.slice(0, MAX_BODY_CHARS).matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let resolved: URL;
    try { resolved = new URL(decodeEntities(m[1]), pageUrl); } catch { continue; }
    if (resolved.origin !== origin) continue;
    resolved.hash = "";
    const href = resolved.toString();
    if (seen.has(href)) continue;
    seen.add(href);
    const text = decodeEntities(m[2].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim().slice(0, MAX_LINK_TEXT);
    links.push({ url: href, text });
  }
  return links;
}

function tokens(s: string): string[] {
  return s.toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !/^v\d+$/.test(t))
    .map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t));
}

/** How well a link matches the missing page: words from the missing page's
 *  last path segment count double, the rest of its path once. */
export function scoreLead(missingUrl: string, link: { url: string; text: string }): number {
  const segments = new URL(missingUrl).pathname.split("/").filter(Boolean);
  const last = new Set(tokens(segments.at(-1) ?? ""));
  const rest = new Set(tokens(segments.slice(0, -1).join(" ")).filter((t) => !last.has(t)));
  const linkTokens = new Set([...tokens(new URL(link.url).pathname), ...tokens(link.text)]);
  let score = 0;
  for (const t of last) if (linkTokens.has(t)) score += 2;
  for (const t of rest) if (linkTokens.has(t)) score += 1;
  return score;
}

function pageKey(url: string): string {
  const u = new URL(url);
  u.hash = "";
  u.search = "";
  return u.toString().replace(/\/$/, "");
}

/**
 * Collect ranked leads for `missingUrl`. `notFoundBody` is the 404 response
 * body when the caller already has it. Stops fetching parents once a page
 * yields a link that matches the missing page's own name.
 */
export async function gatherMissingPageLeads(
  missingUrl: string,
  notFoundBody: string | null,
  fetchPage: LeadPageFetcher = fetchHtmlPage,
): Promise<MissingPageLeads> {
  const missingKey = pageKey(missingUrl);
  const lastWords = tokens(new URL(missingUrl).pathname.split("/").filter(Boolean).at(-1) ?? "");
  const checked: string[] = [];
  const best = new Map<string, PageLead>();
  const indexLinks: PageLead[] = [];

  const absorb = (html: string, foundOn: string): boolean => {
    let matchedName = false;
    for (const link of extractSameOriginLinks(html, foundOn)) {
      if (pageKey(link.url) === missingKey || checked.includes(pageKey(link.url))) continue;
      const score = scoreLead(missingUrl, link);
      if (score > 0) {
        const prior = best.get(link.url);
        if (!prior || prior.score < score) best.set(link.url, { ...link, foundOn, score });
        if (lastWords.length === 0 || score >= 2) matchedName = true;
      } else if (indexLinks.length < MAX_INDEX_LINKS && link.text) {
        indexLinks.push({ ...link, foundOn, score: 0 });
      }
    }
    return matchedName;
  };

  if (notFoundBody) {
    checked.push(missingKey);
    if (absorb(notFoundBody, missingUrl)) return finish();
  }
  for (const parent of ancestorUrls(missingUrl).slice(0, MAX_ANCESTOR_FETCHES)) {
    const html = await fetchPage(parent).catch(() => null);
    checked.push(pageKey(parent));
    if (html && absorb(html, parent)) break;
  }
  return finish();

  function finish(): MissingPageLeads {
    const ranked = [...best.values()].sort((a, b) => b.score - a.score).slice(0, MAX_LEADS);
    return { leads: ranked.length > 0 ? ranked : indexLinks.slice(0, MAX_INDEX_LINKS), checked };
  }
}

/** The note appended to a 404 result. Empty when there is nothing to offer. */
export function formatMissingPageLeads(result: MissingPageLeads): string {
  if (result.leads.length === 0) return "";
  const matched = result.leads[0].score > 0;
  const header = matched
    ? "Pages on this site that may have replaced it (links found on the site, not yet opened):"
    : "No link matched the missing page's name. Links on the nearest index page:";
  const lines = result.leads.map((l) => `- "${l.text || l.url}" → ${l.url} (listed on ${l.foundOn})`);
  return `${header}\n${lines.join("\n")}`;
}

export async function fetchHtmlPage(url: string): Promise<string | null> {
  const res = await canonicalFetch(url, { timeoutMs: 5_000, headers: { Accept: "text/html" } });
  if (!res.ok) { await res.body?.cancel().catch(() => {}); return null; }
  const type = (res.headers.get("content-type") || "").toLowerCase();
  if (type && !/text\/html|application\/xhtml/.test(type)) { await res.body?.cancel().catch(() => {}); return null; }
  return (await res.text()).slice(0, MAX_BODY_CHARS);
}
