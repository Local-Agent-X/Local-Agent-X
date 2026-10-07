/**
 * How a memory search hit is presented: which part of a chunk its snippet
 * shows, when its content was said, and the note that says a snippet was cut.
 * Used by toSearchResult / describeChunkProvenance (search-helpers.ts), the
 * search tools and the past-message reader, so every surface presents a hit
 * the same way. Leaf module: types only.
 */
import type { ChunkMetadata, MemoryProvenance } from "./types.js";

/**
 * The excerpt of a chunk a search result shows: the whole text when it fits,
 * otherwise a window that starts a little before the first query term it
 * contains. Taking the first N characters meant a match deep in a long chunk
 * was cut off and the hit read as a miss (2026-10-05: the quote sat at char
 * 1985 of a 2374-char summary shown to 500). A cut end is marked with "…" and
 * the window is reported, so the cut is never silent.
 */
export function excerptAround(text: string, query: string | undefined, max: number): { snippet: string; window?: { start: number; end: number; total: number } } {
  if (text.length <= max) return { snippet: text };
  let at = -1;
  if (query) {
    const lower = text.toLowerCase();
    const terms = query.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter((t) => t.length >= 3).sort((a, b) => b.length - a.length);
    const phrase = query.toLowerCase().trim();
    at = phrase.length >= 3 ? lower.indexOf(phrase) : -1;
    for (const t of terms) { if (at >= 0) break; at = lower.indexOf(t); }
  }
  let start = at > 0 ? Math.max(0, at - Math.floor(max / 4)) : 0;
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space > 0 && space - start < 40) start = space + 1;
  }
  start = Math.min(start, text.length - max);
  const end = Math.min(text.length, start + max);
  const snippet = (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
  return { snippet, window: { start, end, total: text.length } };
}

/** When a chunk's content was said, in words a model and a person read the
 *  same way: the exact local time for a session exchange whose time is known,
 *  the chat's start date flagged as approximate when it is not, else the
 *  stored day. One rendering for every surface that dates a hit. */
export function describeWhen(metadata: ChunkMetadata | undefined): string | undefined {
  if (metadata?.datetime) {
    const d = new Date(metadata.datetime);
    if (!Number.isNaN(d.getTime())) {
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} local`;
    }
  }
  if (metadata?.date_approx && metadata.date) return `${metadata.date} (chat start; exact time unknown)`;
  return metadata?.date;
}

/** A search hit's excerpt note: shown only when the snippet was cut, saying
 *  what part is shown and how to read the rest. */
export function excerptNote(r: { snippetWindow?: { start: number; end: number; total: number }; provenance?: MemoryProvenance }): string {
  const w = r.snippetWindow;
  if (!w) return "";
  const more = r.provenance?.message_ids?.length
    ? `; full text: search_past_sessions message_id="${r.provenance.message_ids[0]}"`
    : "";
  return `\n[excerpt: characters ${w.start}–${w.end} of ${w.total}${more}]`;
}
