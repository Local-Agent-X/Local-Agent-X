/**
 * Secret scanner — unicode-normalization view + known-secret-value detection.
 *
 * The char-by-char normalized-view builder (homoglyph fold + control/zero-width
 * strip + NFKC/NFKD + combining-mark strip, with an output→source index map) and
 * the two passes that consume it: the normalized-view credential pass and the
 * known-secret-value pass. The known-value pass reuses the decode engine's
 * bounded peel (iterativeRunViews / ENCODED_SCHEMES / MAX_DECODED_BUDGET) so it
 * can't drift from the catalog pass on encoding handling.
 */

import { CREDENTIAL_PATTERNS } from "./credential-patterns.js";
import { normalizeHomoglyphs, stripControlChars } from "../sanitize.js";
import { knownSecretValues, hasKnownSecretValues } from "./known-secrets.js";
import {
  type SecretMatch,
  type Budget,
  maskSecret,
  ENCODED_SCHEMES,
  MAX_DECODED_BUDGET,
  iterativeRunViews,
} from "./secret-decode-engine.js";

// Build the normalized view char-by-char so every output position maps back to
// the source index: homoglyph substitution + control/zero-width stripping
// (reusing sanitize.ts), then NFKC — the same canonical fold checkMemoryTaint
// applies, which collapses fullwidth/compatibility homoglyphs to their ASCII
// form. Stripping deletes chars and NFKC can expand one char into several, so
// indices don't line up with the original; the per-output-char map (outToOrig)
// lets callers emit a span over the real offending run. Shared by the
// credential-pattern normalized pass and the known-value normalized pass so the
// (potentially expensive) fold + index map is built once per scan.
// Combining marks of EVERY Unicode block, not just the basic Combining
// Diacritical block (U+0300–U+036F). An attacker can interleave a mark after
// every secret character ("s" + U+0301 + "k" + U+0301 + …); NFKC only composes
// base+mark where a precomposed form exists, so the bare ASCII run never
// re-forms and every pass misses it. Narrowing the strip to one block let a
// mark from any OTHER Mn block survive (U+0951 Devanagari, U+1DC0 Combining
// Diacritical Supplement, U+20D0 Combining Diacritical for Symbols, U+FE20
// Combining Half Marks, U+05B0 Hebrew, U+064B Arabic, …). `\p{Mn}` (nonspacing)
// plus `\p{Me}` (enclosing) covers every combining-mark block. We NFKD-decompose
// first so a precomposed `é` splits into `e`+U+0301 and the mark is stripped —
// legit accented prose (café, naïve, Zürich) folds to its bare ASCII form, which
// is detection-only and trips no credential/known-value pattern (verified no FP).
// SCOPED TO THE SCANNER VIEW — user-facing rendering (sanitize.ts) is unchanged.
const COMBINING_MARKS_RE = /[\p{Mn}\p{Me}]/gu;

export function buildNormalizedView(text: string): { normalized: string; outToOrig: number[] } {
  let normalized = "";
  const outToOrig: number[] = []; // normalized char index → original text index
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (stripControlChars(ch) === "") continue; // control / zero-width → dropped
    // NFKC folds fullwidth/compatibility homoglyphs; NFKD then re-splits any
    // base+mark and we drop the marks, so an interleaved-diacritic secret
    // collapses to the detectable bare run. A char that IS only a combining
    // mark folds to "" and is dropped (no output index → not in the map).
    const folded = normalizeHomoglyphs(ch)
      .normalize("NFKC")
      .normalize("NFKD")
      .replace(COMBINING_MARKS_RE, "");
    for (let k = 0; k < folded.length; k++) outToOrig.push(i);
    normalized += folded;
  }
  return { normalized, outToOrig };
}

/**
 * Detect secrets visible only after unicode normalization, using the prebuilt
 * normalized view. Spans are mapped back to the original text so redaction
 * removes the real offending run. Additive over raw matches.
 */
export function scanNormalizedView(
  text: string,
  rawMatches: SecretMatch[],
  view: { normalized: string; outToOrig: number[] }
): SecretMatch[] {
  const { normalized, outToOrig } = view;
  if (normalized === text) return [];

  const out: SecretMatch[] = [];
  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(normalized)) !== null) {
      const ns = match.index;
      const ne = match.index + match[0].length;
      const origStart = outToOrig[ns] ?? ns;
      const origEnd = ne - 1 < outToOrig.length
        ? (outToOrig[ne - 1] ?? ne - 1) + 1
        : text.length;
      // Skip if this span is already covered by a raw match (additive only).
      if (rawMatches.some(r => r.startIndex <= origStart && r.endIndex >= origEnd)) continue;
      const value = match[1] || match[0];
      out.push({
        type: "obfuscated",
        pattern: `${pattern.name} (unicode)`,
        value: value.slice(0, 20) + (value.length > 20 ? "..." : ""),
        masked: maskSecret(value),
        startIndex: origStart,
        endIndex: origEnd,
      });
    }
  }
  return out;
}

// ── Known-secret-value detection ───────────────────────────────────────────
//
// The egress check with the fewest false positives is matching the user's
// ACTUAL stored secret values (registered from the SecretsStore) — not "looks
// secret-ish." A registered value (or its encoded/normalized form) appearing in
// an outbound payload makes the scan NOT clean even when it matches no pattern,
// so the egress guard BLOCKS and the taint path TAINTS. Spans always point at
// the real offending bytes in `text` so redactSecrets strips something real.

/** Find every occurrence of `needle` in `hay`, returning [start,end) spans. */
function findAllSpans(hay: string, needle: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  if (!needle) return spans;
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) break;
    spans.push({ start: idx, end: idx + needle.length });
    from = idx + needle.length;
  }
  return spans;
}

function knownValueMatch(start: number, end: number): SecretMatch {
  // Never echo the value: mask is fixed and `value` is empty so the literal
  // secret can't leak through a logged SecretMatch.
  return {
    type: "known-secret-value",
    pattern: "Known Secret Value",
    value: "",
    masked: "***",
    startIndex: start,
    endIndex: end,
  };
}

/**
 * Detect any registered known secret value in `text` — raw, in a decoded
 * encoded-run, or in the normalized view — reusing the SAME decode/normalize
 * machinery the credential passes use. Values are gated by isSecretShaped at
 * registration time, so short/low-entropy values never reach here (no FP).
 */
export function scanKnownValues(
  text: string,
  view: { normalized: string; outToOrig: number[] }
): SecretMatch[] {
  if (!hasKnownSecretValues()) return [];
  const values = knownSecretValues(); // longest-first
  const out: SecretMatch[] = [];

  // 1) Raw occurrences.
  for (const v of values) {
    for (const s of findAllSpans(text, v)) out.push(knownValueMatch(s.start, s.end));
  }

  // 2) Encoded views: a value hidden inside a base64/hex/percent run. Attribute
  //    to the ORIGINAL encoded blob so redaction removes the whole thing.
  //    C3-8: uses the SAME iterativeRunViews helper as scanEncodedViews (multi-
  //    layer peel, shared byte budget) — previously this pass did a single decode
  //    while the catalog pass decoded an inner layer, so base64(base64(known))
  //    leaked. Sharing the helper means the two passes can't drift on depth.
  const budget: Budget = { remaining: MAX_DECODED_BUDGET };
  for (const scheme of ENCODED_SCHEMES) {
    if (budget.remaining <= 0) break;
    scheme.re.lastIndex = 0;
    for (const m of text.matchAll(scheme.re)) {
      if (budget.remaining <= 0) break;
      const run = m[0];
      const index = m.index ?? 0;
      const decodedViews = iterativeRunViews(scheme, run, budget);
      if (decodedViews.some((d) => values.some((v) => d.includes(v)))) {
        out.push(knownValueMatch(index, index + run.length));
      }
    }
  }

  // 3) Normalized view: a value split/disguised by homoglyphs or zero-width
  //    chars. Map the normalized span back to the source bytes.
  const { normalized, outToOrig } = view;
  if (normalized !== text) {
    for (const v of values) {
      for (const s of findAllSpans(normalized, v)) {
        const origStart = outToOrig[s.start] ?? s.start;
        const origEnd =
          s.end - 1 < outToOrig.length ? (outToOrig[s.end - 1] ?? s.end - 1) + 1 : text.length;
        out.push(knownValueMatch(origStart, origEnd));
      }
    }
  }

  return out;
}
