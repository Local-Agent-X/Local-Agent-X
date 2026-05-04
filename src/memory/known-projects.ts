/**
 * Known-project auto-recall trigger.
 *
 * The Step #1 cross-session lockdown moved past-session content behind an
 * explicit `search_past_sessions` tool. That eliminated the bleed but lost
 * the magic of "I mentioned baddiesandsugardaddies yesterday and the agent
 * remembers we built a landing page for it." The agent never proactively
 * called the tool — yesterday's work was invisible.
 *
 * This helper bridges the gap NARROWLY: when the user's current message
 * mentions a domain or project name that exists in a prior session summary,
 * append a one-line nudge to the system prompt: "You've worked on X before
 * — call search_past_sessions if you need context." The model decides
 * whether to actually pull the history. Bleed-safe because it's just a
 * pointer, not a content dump.
 */

import type { MemoryIndex } from "./index-core.js";

// Domain-like token: contains a known TLD. Conservative list — adding more
// (e.g. .net, .org) is fine, the chunks search will still gate by actual
// presence in past sessions before we nudge.
const DOMAIN_RE = /\b([a-z][a-z0-9-]{2,}(?:\.[a-z]{2,}){1,3})\b/gi;
const KNOWN_TLDS = new Set([
  "com", "io", "app", "ai", "dev", "co", "net", "org", "xyz", "shop",
  "store", "tech", "design", "studio", "agency", "info", "me",
]);

function extractDomainCandidates(text: string): string[] {
  const out = new Set<string>();
  const matches = text.toLowerCase().matchAll(DOMAIN_RE);
  for (const m of matches) {
    const tld = m[1].split(".").pop() || "";
    if (KNOWN_TLDS.has(tld)) out.add(m[1]);
  }
  return [...out];
}

export interface KnownProjectMatch {
  token: string;
  matchedSessionIds: string[];
  topSnippet?: string;
}

/**
 * Scan the user message for project / domain references, then check whether
 * any have prior session-summary content. Returns at most `maxMatches` to
 * keep the nudge short. Empty array = nothing to nudge about (the common
 * case — most messages don't reference past projects).
 */
export async function findKnownProjectsInMessage(
  memory: MemoryIndex,
  userMessage: string,
  opts?: { maxMatches?: number; currentSessionId?: string },
): Promise<KnownProjectMatch[]> {
  const tokens = extractDomainCandidates(userMessage);
  if (tokens.length === 0) return [];

  const max = opts?.maxMatches ?? 3;
  const matches: KnownProjectMatch[] = [];

  for (const token of tokens) {
    if (matches.length >= max) break;
    try {
      const results = await memory.search(token, {
        maxResults: 3,
        sources: ["session-summary", "session"],
        crossSession: true,
      });
      // Filter out chunks that are from the CURRENT session — we only care
      // about prior-session matches (the current session's summary doesn't
      // exist yet anyway, but defensive).
      const otherSession = results.filter(
        (r) => !opts?.currentSessionId || r.metadata?.session_id !== opts.currentSessionId,
      );
      if (otherSession.length === 0) continue;
      const sessionIds = new Set<string>();
      for (const r of otherSession) {
        if (r.metadata?.session_id) sessionIds.add(r.metadata.session_id);
      }
      matches.push({
        token,
        matchedSessionIds: [...sessionIds],
        topSnippet: otherSession[0].snippet?.slice(0, 200),
      });
    } catch {
      // Search failure → skip, not blocking
    }
  }

  return matches;
}

/**
 * Build the system-prompt nudge text for the matches. Returns "" if there
 * are no matches. Format: short pointer (no content) so the agent decides
 * whether to call `search_past_sessions`.
 */
export function buildKnownProjectsNudge(matches: KnownProjectMatch[]): string {
  if (matches.length === 0) return "";
  const list = matches.map((m) => `"${m.token}"`).join(", ");
  return (
    `\n\n<known_projects>\n` +
    `The user's current message references ${list} — you have prior session(s) about this. ` +
    `If you need context to answer well, call \`search_past_sessions\` with the relevant query before responding. ` +
    `Otherwise, proceed normally.\n` +
    `</known_projects>`
  );
}
