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
 *
 * When the matching lines carry dates (a page of facts, each "recorded
 * YYYY-MM-DD"), the window opens on the newest of them instead: the first
 * match is the oldest entry on such a page, so the excerpt showed a May vial
 * and cut off the October one that replaced it (2026-11-04).
 */
export function excerptAround(text: string, query: string | undefined, max: number): { snippet: string; window?: { start: number; end: number; total: number } } {
  if (text.length <= max) return { snippet: text };
  let at = -1;
  if (query) {
    const lower = text.toLowerCase();
    const terms = query.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter((t) => t.length >= 3).sort((a, b) => b.length - a.length);
    const phrase = query.toLowerCase().trim();
    const newest = newestMatchingDatedLine(lower, phrase.length >= 3 ? [phrase, ...terms] : terms);
    if (newest >= 0) return windowFrom(text, newest, max);
    at = phrase.length >= 3 ? lower.indexOf(phrase) : -1;
    for (const t of terms) { if (at >= 0) break; at = lower.indexOf(t); }
  }
  let start = at > 0 ? Math.max(0, at - Math.floor(max / 4)) : 0;
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space > 0 && space - start < 40) start = space + 1;
  }
  return windowFrom(text, start, max);
}

function windowFrom(text: string, from: number, max: number): { snippet: string; window: { start: number; end: number; total: number } } {
  const start = Math.min(from, text.length - max);
  const end = Math.min(text.length, start + max);
  const snippet = (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
  return { snippet, window: { start, end, total: text.length } };
}

const ISO_DAY = /\b(20\d\d-\d\d-\d\d)\b/g;

/** Where the newest dated line containing a query term starts, or -1 when no
 *  matching line carries a date. A line's date is the latest one it names. */
function newestMatchingDatedLine(lower: string, terms: readonly string[]): number {
  let best = -1;
  let bestDay = "";
  let lineStart = 0;
  for (const line of lower.split("\n")) {
    if (terms.some((t) => line.includes(t))) {
      const days = [...line.matchAll(ISO_DAY)].map((m) => m[1]).sort();
      const day = days[days.length - 1];
      if (day && day > bestDay) { bestDay = day; best = lineStart; }
    }
    lineStart += line.length + 1;
  }
  return best;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** A stored moment as the LOCAL calendar day (YYYY-MM-DD) — the clock the
 *  prompt's "Today is …" is written in (context.ts <current_datetime>). Dating
 *  memory in UTC beside it made a fact saved at 20:55 local read as saved
 *  "tomorrow", and the agent took that as a sign the fact was fabricated
 *  (eval run, 2026-10-08). Every date shown to the model uses this. */
export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** When a chunk's content was said, in words a model and a person read the
 *  same way: the exact local time for a session exchange whose time is known,
 *  the chat's start date flagged as approximate when it is not, else the
 *  stored day. One rendering for every surface that dates a hit. */
export function describeWhen(metadata: ChunkMetadata | undefined): string | undefined {
  if (metadata?.datetime) {
    const d = new Date(metadata.datetime);
    if (!Number.isNaN(d.getTime())) {
      return `${localDate(d.getTime())} ${pad2(d.getHours())}:${pad2(d.getMinutes())} local`;
    }
  }
  if (metadata?.date_approx && metadata.date) return `${metadata.date} (chat start; exact time unknown)`;
  return metadata?.date;
}

/** The local calendar day a chunk's content was said: from its exact time when
 *  known, else its stored day; undefined when it has neither. Date filters
 *  compare this — the model asks in local days (the prompt's "Today is …"),
 *  and the stored `date` is the UTC day, a day ahead every evening. */
export function chunkLocalDay(metadata: ChunkMetadata | undefined): string | undefined {
  const t = metadata?.datetime ? Date.parse(metadata.datetime) : NaN;
  return Number.isNaN(t) ? metadata?.date : localDate(t);
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
