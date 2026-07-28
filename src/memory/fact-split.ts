// Multi-fact splitting for the `remember` tool — PURE text logic only.
//
// The blob guard used to answer a batched `remember` with a "split it and
// retry" hint — one extra inference round trip per fact (11 interleaved
// remember calls were measured in a single small bugfix session). The split
// now happens in code, and this module is deliberately a LEAF (no imports):
// both the dispatch approval phase (promotion-gate.ts, which stamps the
// capability over the canonical text and derives per-fact child capabilities
// by re-running THIS splitter on the stamped string) and the tool sink
// (memory/tools/facts.ts) need it, and promotion-gate must not import
// anything that transitively imports it back (write-safely → promotion-gate).

// A single durable fact is one compact line. These tight signals detect a
// multi-fact dump crammed into one `remember` call. Tuned for near-zero
// false positives: a 1-2 sentence single-line fact under 400 chars always
// passes. Formerly the reject-guard in facts.ts; now it is the splitter's
// trigger — same heuristic, one source of truth.
export function looksLikeMultiFactBlob(content: string): boolean {
  if (content.includes("\n")) return true;
  if (content.length > 400) return true;
  const sentenceBoundaries = content.match(/[.!?](\s|$)/g);
  if (sentenceBoundaries && sentenceBoundaries.length >= 4) return true;
  return false;
}

// Flood bound: the tainted-promotion quota (promotion-gate.ts) counts CALLS,
// so an unbounded batch would multiply what an injected page can persist per
// call. Facts past the cap are reported honestly, never silently dropped.
export const MAX_FACTS_PER_CALL = 25;

const LIST_MARKER = /^(?:[-*•]|\d+[.)])\s+/;

/** A fact is ONE line by invariant (the DB sink is a line-oriented bullet
 *  parser). Collapsing newline runs here — the same normalization
 *  index-facts-mutate.ts applies before formatting a bullet — is what makes
 *  join→split a lossless round trip: after it, one line == one fact, so a
 *  batch of N declared facts can never derive to anything but N. */
export function normalizeFactLine(text: string): string {
  return String(text).trim().replace(/\s*[\r\n]+\s*/g, " ");
}

/** Inverse of joinFactsForPromotion: recover the caller's declared facts from
 *  the stamped text. Items the model passed in `facts[]` are ALREADY declared
 *  atomic, so they are never sentence-split — splitting them would contradict
 *  the declaration, inflate the count on the human approval card (which counts
 *  lines of the stamped join), and let an earlier item's sentences push a
 *  later declared fact over the per-call cap. */
export function splitDeclaredFacts(joined: string): string[] {
  return joined.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Split a multi-fact dump into atomic facts, using the same boundaries the
 *  blob guard scores: newlines first (list markers stripped), then sentence
 *  boundaries for a line that alone still reads as a dump. An unsplittable
 *  long sentence stays whole — one long fact beats a retry round trip. */
export function splitMultiFactBlob(content: string): string[] {
  const lines = content
    .split("\n")
    .map((line) => line.trim().replace(LIST_MARKER, ""))
    .filter(Boolean);
  const out: string[] = [];
  for (const line of lines) {
    if (!looksLikeMultiFactBlob(line)) {
      out.push(line);
      continue;
    }
    out.push(...line.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean));
  }
  return out;
}
