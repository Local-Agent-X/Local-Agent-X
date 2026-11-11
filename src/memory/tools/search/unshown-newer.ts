// What a by-meaning search of past chats leaves out. It shows the few best
// matches, and "best" is closeness to the query, not recency: asked about an
// interview the user had talked through that afternoon, it returned five
// pieces of the day before's practice chats, and the agent told the user that
// afternoon's chat "didn't save" (voice call, 2026-11-10). The chat was a
// match, one place below the cut. So the result says when chats newer than
// everything shown also matched, and names them, instead of leaving the model
// to read a short list as the whole record.

import type { MemorySearchResult } from "../../types.js";

/** How many newer chats the note names. */
const NAMED_MAX = 3;

/** When a hit was said, in epoch ms: the exchange's own time, else its chat's
 *  day, else when its text was last indexed. 0 when nothing dates it. */
export function saidAt(r: MemorySearchResult): number {
  for (const stamp of [r.metadata?.datetime, r.provenance?.date, r.metadata?.date]) {
    const t = stamp ? Date.parse(stamp) : NaN;
    if (Number.isFinite(t)) return t;
  }
  return r.updatedAt ?? 0;
}

export interface UnshownNewer {
  /** Matches below the cut, of any age. */
  unshown: number;
  /** Chats below the cut that are newer than every shown hit, newest first. */
  newerChats: Array<{ sessionId: string; label: string; when: string }>;
}

/** The matches below the cut that are newer than everything above it, one
 *  entry per chat. A chat already shown is not named again. */
export function unshownNewer(shown: readonly MemorySearchResult[], rest: readonly MemorySearchResult[]): UnshownNewer {
  const newestShown = Math.max(0, ...shown.map(saidAt));
  const shownChats = new Set(shown.map((r) => r.provenance?.session_id));
  const byChat = new Map<string, { sessionId: string; label: string; when: string; at: number }>();
  for (const r of rest) {
    const sessionId = r.provenance?.session_id;
    const at = saidAt(r);
    if (!sessionId || shownChats.has(sessionId) || at <= newestShown) continue;
    const seen = byChat.get(sessionId);
    if (seen && seen.at >= at) continue;
    byChat.set(sessionId, {
      sessionId,
      label: r.provenance?.label || r.metadata?.topic || "untitled chat",
      when: r.provenance?.when ?? r.provenance?.date ?? r.metadata?.date ?? "",
      at,
    });
  }
  const newerChats = [...byChat.values()].sort((a, b) => b.at - a.at).map(({ sessionId, label, when }) => ({ sessionId, label, when }));
  return { unshown: rest.length, newerChats };
}

/** The line the search result ends with, or "" when nothing newer was cut. */
export function unshownNewerNote(found: UnshownNewer): string {
  if (found.newerChats.length === 0) return "";
  const named = found.newerChats.slice(0, NAMED_MAX)
    .map((c) => `- ${JSON.stringify(c.label)}${c.when ? ` ${c.when}` : ""} session=${c.sessionId}`)
    .join("\n");
  const more = found.newerChats.length > NAMED_MAX ? ` (and ${found.newerChats.length - NAMED_MAX} more)` : "";
  return (
    `NOT SHOWN: ${found.unshown} more match(es) ranked below these, and ${found.newerChats.length} chat(s) among them are NEWER than everything above${more}:\n` +
    `${named}\n` +
    `The list above is the closest matches, not the latest. If the user means something recent, search again with since set to that day, or with exact and a word they used, before saying it is not there.\n`
  );
}
