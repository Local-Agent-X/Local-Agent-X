/**
 * Which retained facts the prompt's <core_memory> block holds, and how each
 * reads. context.ts wraps the body in the block; this owns the selection.
 *
 * Two passes. First, what happened in the user's life in the last few local
 * days, newest first, under its own byte budget. Then the hot-score pick
 * (confidence × decay since the fact was last touched) fills the usual
 * budget. The hot score alone ranks by last touch, and an old fact is touched
 * every time it comes up again: fifteen of sixty candidates fit the budget,
 * all reinforced months-old facts, and "Peter completed his first interview
 * … on 2026-11-10" was cut. The next afternoon a spoken "how are you?" asked
 * whether the interview was "around now" (2026-11-11).
 */
import type { MemoryIndex } from "./index-core.js";
import type { FactKind, RetainedFact } from "./types.js";
import { factTrustSuffix } from "./fact-provenance-label.js";
import { localDate } from "./retrieval-format.js";

// Whole-day index (days since epoch) of `ms` on the LOCAL calendar in `tz`.
// Day-quantized comparisons keep stable-section rendering from flipping
// intra-day — flips land on the same midnight rollover that already
// refreshes the volatile <current_datetime>.
function localDayNumber(ms: number, tz: string): number {
  const [y, m, d] = new Date(ms).toLocaleDateString("en-CA", { timeZone: tz }).split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

/** Today and the two local days before it. */
const RECENT_DAYS = 2;
const RECENT_MAX_BYTES = 2000;
// Biographical events within this window are flagged as "still fresh" — a
// salience signal so a recent loss / move / milestone gets acknowledged with
// care. Compared at local-day granularity: an ms-precision "now" flipped
// stable bytes mid-session as facts aged across the raw boundary.
const FRESH_WINDOW_DAYS = 14;
const MIN_CONFIDENCE = 0.4;

// Relational labels (May 2026) — schema-flavored labels (Identity /
// Preferences / …) made the model read this as a cold database. Second-
// person relational wording keeps it in the "you know this person" frame
// every turn without prompt-level reminders.
const HEADINGS: Array<[FactKind, string]> = [
  ["world", "Things you know about them"],
  ["opinion", "How they like things"],
  ["experience", "Recent in their life"],
  ["observation", "Other notes"],
];

export interface CoreMemoryBody {
  /** The `## heading` sections, empty when no fact was selected. */
  body: string;
  /** Fact ids rendered — <known_entities> never repeats one. */
  renderedIds: Set<number>;
}

type CoreMemorySource = Pick<MemoryIndex, "recallRecentFacts" | "recallByTime" | "getConfig">;

export function coreMemoryBody(memory: CoreMemorySource, tz: string, now = Date.now()): CoreMemoryBody {
  const cfg = memory.getConfig();
  const todayNum = localDayNumber(now, tz);
  const lineOf = (f: RetainedFact): string => {
    const ents = f.entities.length > 0 ? ` (@${f.entities.join(", @")})` : "";
    let prefix = "";
    let suffix = "";
    if (f.kind === "experience" && f.timestamp) {
      prefix = `${localDate(f.timestamp)}: `;
      if (todayNum - localDayNumber(f.timestamp, tz) < FRESH_WINDOW_DAYS) suffix = " — still fresh";
    }
    return `- ${prefix}${f.content}${ents}${suffix}${factTrustSuffix(f.sourceFile)}`;
  };

  const selected: Array<{ id: number; kind: FactKind; line: string }> = [];
  const taken = new Set<number>();
  const fill = (facts: RetainedFact[], maxBytes: number): void => {
    let bytes = 0;
    for (const f of facts) {
      if (f.id !== undefined && taken.has(f.id)) continue;
      const line = lineOf(f);
      bytes += line.length + 1;
      if (bytes > maxBytes) break;
      selected.push({ id: f.id ?? Number.MAX_SAFE_INTEGER, kind: f.kind, line });
      if (f.id !== undefined) taken.add(f.id);
    }
  };

  const recent = memory
    .recallByTime(new Date(now - (RECENT_DAYS + 1) * 86400000), new Date(now), 100)
    .filter((f) => f.kind === "experience" && f.confidence >= MIN_CONFIDENCE && todayNum - localDayNumber(f.timestamp, tz) <= RECENT_DAYS)
    // Surest first, then newest: a day of mock-interview stories (0.8) filled
    // the budget ahead of the interview itself (1.0).
    .sort((a, b) => b.confidence - a.confidence || b.timestamp - a.timestamp);
  fill(recent, RECENT_MAX_BYTES);
  fill(memory.recallRecentFacts({
    kinds: ["world", "experience", "opinion", "observation"],
    limit: cfg.coreFactsLimit,
    minConfidence: MIN_CONFIDENCE,
  }), cfg.coreFactsMaxBytes);

  // Stable render order: fact id ascending (== insertion order — ids are
  // monotonic and immutable, unlike hot-score, and read chronologically).
  // Same selected set → same bytes. Line text tiebreaks id-less facts.
  selected.sort((a, b) => a.id - b.id || a.line.localeCompare(b.line));
  const buckets: Record<FactKind, string[]> = { world: [], opinion: [], experience: [], observation: [] };
  const renderedIds = new Set<number>();
  for (const s of selected) {
    buckets[s.kind].push(s.line);
    if (s.id !== Number.MAX_SAFE_INTEGER) renderedIds.add(s.id);
  }
  const body = HEADINGS
    .filter(([k]) => buckets[k].length > 0)
    .map(([k, label]) => `## ${label}\n${buckets[k].join("\n")}`)
    .join("\n\n");
  return { body, renderedIds };
}
