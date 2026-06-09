/**
 * Secrets Auto-Detection
 *
 * Scans outbound text for API key patterns, credentials,
 * and other secrets before they leave the system.
 *
 * The pattern catalog is NOT defined here — it lives in the canonical
 * credential-patterns.ts (CREDENTIAL_PATTERNS) so the inline redactor and
 * this position-aware scanner can never drift. Add new shapes there.
 */

import { CREDENTIAL_PATTERNS } from "./credential-patterns.js";
import { detectHighEntropyTokens } from "./entropy-detector.js";
import { normalizeHomoglyphs, stripControlChars } from "../sanitize.js";
import { knownSecretValues, hasKnownSecretValues } from "./known-secrets.js";

export interface SecretMatch {
  type: string;
  pattern: string;
  value: string;
  masked: string;
  startIndex: number;
  endIndex: number;
}

interface ScanResult {
  clean: boolean;
  matches: SecretMatch[];
  scannedLength: number;
}

function maskSecret(value: string): string {
  if (value.length <= 8) return "***";
  return value.slice(0, 4) + "***" + value.slice(-4);
}

// ── Decode/normalize evasion defense ──────────────────────────────────────
//
// scanForSecrets matches the credential catalog against the RAW text. An
// attacker (or a compromised model) can evade that by encoding the secret:
// base64("sk-ant-…") or its hex/percent-encoded/unicode-obfuscated forms sail
// past a raw regex. The passes below detect a secret that is present only in a
// DECODED or NORMALIZED view of the text. Detection (the `clean` flag) is the
// must-have; for redaction we attribute the match to the ORIGINAL span (the
// whole encoded blob, or the normalized-out run) so redactSecrets /
// redactSecretSpans strip something real — never a span that points into a
// derived string that doesn't exist in the caller's text.

// Only credential-pattern matches count — no entropy heuristics — so random
// base64 that decodes to garbage stays clean (near-zero new false positives).
function rawMatchesAny(text: string): boolean {
  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(text)) {
      pattern.regex.lastIndex = 0;
      return true;
    }
  }
  return false;
}

// Name of the first credential pattern the decoded view trips, for the label.
function firstMatchName(text: string): string | undefined {
  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(text)) {
      pattern.regex.lastIndex = 0;
      return pattern.name;
    }
  }
  return undefined;
}

// ── Anchor-relaxed catalog for DERIVED (decoded/normalized-byte) views ─────────
//
// C3-19: many catalog regexes start with `\b` (word boundary). On the RAW text
// that anchor is essential to keep false positives near zero on normal prose.
// But on a DERIVED view we reconstruct — a decoded buffer, a swapped-endian
// utf16le interpretation — the surrounding bytes are attacker-chosen noise, so
// an attacker can prepend one word char before `sk-ant` (`base64(utf16le("x"+KEY))`):
// the leading `x` re-breaks the `\b` that precedes `sk-ant`, and the derived view
// is `xsk-ant-…` which the `\b`-anchored regex misses. For derived views ONLY we
// strip a leading `\b` from each pattern so the prefix byte can't mask the key.
// This DOESN'T explode FPs because (a) it runs only on reconstructed bytes already
// gated by decode round-trips / normalization, never raw prose, and (b) the
// pattern body itself (`sk-ant-…{20,}`, `AKIA…{16}`, an `eyJ…` JWT triple) is the
// discriminating signal — the `\b` was a cheap pre-filter, not the security.
const DERIVED_VIEW_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> =
  CREDENTIAL_PATTERNS.map((p) => ({
    name: p.name,
    regex: new RegExp(p.regex.source.replace(/^\\b/, ""), p.regex.flags),
  }));

// firstMatchName for a DERIVED view: uses the anchor-relaxed catalog so a synthetic
// prefix byte can't hide a key behind a broken `\b`.
function firstMatchNameDerived(text: string): string | undefined {
  for (const pattern of DERIVED_VIEW_PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(text)) {
      pattern.regex.lastIndex = 0;
      return pattern.name;
    }
  }
  return undefined;
}

// Total decoded bytes we're willing to feed back through the regex pass, across
// all candidate runs in one scan. A genuine payload that buries a key in a few
// encoded blobs stays well under this; a multi-megabyte blob that would blow up
// CPU is already suspicious egress and we accept not decoding all of it.
const MAX_DECODED_BUDGET = 256 * 1024;
// Don't bother decoding runs shorter than this — a real key is >=20 chars, so
// its encodings are longer; this kills the "base64-decode every short token"
// cost. Mirrors the catalog's >=20-char key floor.
const MIN_BASE64_RUN = 16;
const MIN_HEX_RUN = 32;

// Candidate encoded runs: base64/base64url, hex, percent-encoded.
const BASE64_RUN_RE = /[A-Za-z0-9+/_-]{16,}={0,2}/g;
const HEX_RUN_RE = /\b[0-9a-fA-F]{32,}\b/g;
const PERCENT_RUN_RE = /(?:%[0-9a-fA-F]{2}|[^\s%]){8,}/g;

// Decode a base64/base64url run to its raw bytes, applying the same
// normalize + round-trip sanity the catalog decode relies on. Returns the
// Buffer (so callers can take MULTIPLE text interpretations of the same bytes)
// or null when the run isn't real base64.
function decodeBase64Buffer(run: string): Buffer | null {
  // Normalize base64url → base64 and length-sanity before decoding.
  const normalized = run.replace(/-/g, "+").replace(/_/g, "/");
  const unpadded = normalized.replace(/=+$/, "");
  if (unpadded.length < MIN_BASE64_RUN) return null;
  if (!/^[A-Za-z0-9+/]+$/.test(unpadded)) return null;
  try {
    const buf = Buffer.from(normalized, "base64");
    if (buf.length === 0) return null;
    // Re-encoding round-trip filters out runs that aren't actually base64.
    if (buf.toString("base64").replace(/=+$/, "") !== unpadded) return null;
    return buf;
  } catch {
    return null;
  }
}

function decodeBase64(run: string): string | null {
  const buf = decodeBase64Buffer(run);
  return buf === null ? null : buf.toString("latin1");
}

// Text interpretations of a decoded buffer's bytes for the catalog + known-value
// passes. A receiver can recover a secret from base64/hex of UTF-16LE bytes
// (`Buffer.from(key,'utf16le').toString('base64'|'hex')`), which the latin1 view
// renders as a NUL-interleaved string — so `decoded.includes(value)` and the
// catalog regexes (which need contiguous chars) both miss it. We additionally
// surface the utf16le view for BOTH byte orders so the recovered key is a
// contiguous run again. swap16 mutates the buffer in place, so decode a fresh
// copy for the second order. Shared by base64 AND hex so the two byte-bearing
// schemes can't drift on "which text interpretations we inspect."
function bufferTextViews(buf: Buffer | null): string[] {
  if (buf === null) return [];
  const views = [buf.toString("latin1"), buf.toString("utf16le")];
  // swap16() requires an even byte length; an odd-length buffer can't be a clean
  // utf16le string in the other byte order, so only the as-decoded order applies.
  if (buf.length >= 2 && buf.length % 2 === 0) {
    const swapped = Buffer.from(buf);
    swapped.swap16();
    views.push(swapped.toString("utf16le"));
  }
  return views;
}

function base64TextViews(run: string): string[] {
  return bufferTextViews(decodeBase64Buffer(run));
}

// Decode a hex run to its raw bytes. Returns the Buffer so callers can take
// MULTIPLE text interpretations (latin1 + both-endian utf16le) — `hex(utf16le(
// key))` is NUL-interleaved in the latin1 view and only contiguous in a utf16le
// view, exactly the base64 case. Returns null when the run isn't clean hex.
function decodeHexBuffer(run: string): Buffer | null {
  if (run.length < MIN_HEX_RUN || run.length % 2 !== 0) return null;
  try {
    const buf = Buffer.from(run, "hex");
    if (buf.length === 0 || buf.length * 2 !== run.length) return null;
    return buf;
  } catch {
    return null;
  }
}

function hexTextViews(run: string): string[] {
  return bufferTextViews(decodeHexBuffer(run));
}

function decodeHex(run: string): string | null {
  const buf = decodeHexBuffer(run);
  return buf === null ? null : buf.toString("latin1");
}

function decodePercent(run: string): string | null {
  if (!run.includes("%")) return null;
  try {
    const decoded = decodeURIComponent(run);
    return decoded === run ? null : decoded;
  } catch {
    return null;
  }
}

interface EncodedScheme {
  re: RegExp;
  decode: (run: string) => string | null;
  label: string;
}

// All decoded text interpretations of a run for one scheme. base64 AND hex are
// byte-bearing, so each yields latin1 + both-endian utf16le views (a key carried
// as base64/hex of UTF-16LE is contiguous only in a utf16le view); percent has a
// single textual decoding.
function runDecodeViews(scheme: EncodedScheme, run: string): string[] {
  if (scheme.label === "base64") return base64TextViews(run);
  if (scheme.label === "hex") return hexTextViews(run);
  const decoded = scheme.decode(run);
  return decoded === null ? [] : [decoded];
}

const ENCODED_SCHEMES: EncodedScheme[] = [
  { re: BASE64_RUN_RE, decode: decodeBase64, label: "base64" },
  { re: HEX_RUN_RE, decode: decodeHex, label: "hex" },
  { re: PERCENT_RUN_RE, decode: decodePercent, label: "percent" },
];

// Max decode layers we'll peel for ONE outer run, counting the outer layer.
// C3-18: a fixed one-extra-layer peel let `base64(base64(hex(secret)))` (3
// layers) sail through clean — defeating the scanner AND the canary gate. We
// iterate to this small bound instead. The shared MAX_DECODED_BUDGET byte
// counter (threaded through every layer/view below) still bounds total work, so
// a nested decompression-bomb input can't blow memory/CPU — depth is capped AND
// bytes are capped, whichever hits first.
const MAX_DECODE_DEPTH = 5;

// Mutable byte-budget cell so one counter is shared across every layer and view
// of every run in a single scan (not per-run), matching the original
// MAX_DECODED_BUDGET intent.
interface Budget {
  remaining: number;
}

/**
 * Iteratively peel an outer encoded run into EVERY decoded text view across up
 * to MAX_DECODE_DEPTH layers, sharing one byte budget. A worklist/queue loop: at
 * each layer, take a view string, re-detect any inner encoded run inside it, and
 * enqueue that run's decode views for the next layer. Every view we produce
 * (latin1, both-endian utf16le, percent text, at every layer) is yielded for the
 * caller to scan. The SINGLE source of "what bytes can be recovered from this
 * run" — scanEncodedViews, scanKnownValues, and decodedPayloadViews all consume
 * it so the catalog pass, the known-value pass, and the taint-overlap check can
 * never drift on encoding handling. Bounded by `budget`.
 */
function iterativeRunViews(
  outerScheme: EncodedScheme,
  outerRun: string,
  budget: Budget
): string[] {
  const collected: string[] = [];
  // Queue of (runString, scheme) to decode. Seed with the outer run.
  const queue: Array<{ run: string; scheme: EncodedScheme }> = [
    { run: outerRun, scheme: outerScheme },
  ];
  let depth = 0;
  while (queue.length > 0 && depth < MAX_DECODE_DEPTH && budget.remaining > 0) {
    const nextLayer: Array<{ run: string; scheme: EncodedScheme }> = [];
    for (const item of queue) {
      if (budget.remaining <= 0) break;
      const views = runDecodeViews(item.scheme, item.run);
      if (views.length === 0) continue;
      for (const v of views) {
        if (budget.remaining <= 0) break;
        // Charge the budget for EVERY materialized view across ALL layers (not
        // just the primary view of each decode) so multi-view × multi-layer
        // amplification is fully counted — this is what bounds a nested
        // decompression-bomb input: each ~N-byte view we produce (and will scan)
        // draws down the shared MAX_DECODED_BUDGET, so total bytes produced AND
        // scanned across the whole peel can't exceed it.
        budget.remaining -= v.length;
        collected.push(v);
        // Look for an inner encoded run in this view to peel on the next layer.
        // Fresh regex per scheme so no shared lastIndex state leaks.
        for (const inner of ENCODED_SCHEMES) {
          const fresh = new RegExp(inner.re.source, inner.re.flags);
          const im = fresh.exec(v);
          if (im) nextLayer.push({ run: im[0], scheme: inner });
        }
      }
    }
    queue.length = 0;
    queue.push(...nextLayer);
    depth++;
  }
  return collected;
}

/**
 * Find encoded runs whose DECODED view trips a credential pattern, and return a
 * SecretMatch per offending run that spans the ORIGINAL encoded blob (so
 * redaction removes the whole thing). Iteratively peels up to MAX_DECODE_DEPTH
 * layers (so multi-round encodings like base64(base64(hex(secret))) are caught),
 * bounded by a shared MAX_DECODED_BUDGET. Derived views are matched with the
 * anchor-relaxed catalog (firstMatchNameDerived) so a synthetic prefix byte
 * can't hide a key behind a broken `\b`.
 */
function scanEncodedViews(text: string): SecretMatch[] {
  const out: SecretMatch[] = [];
  const budget: Budget = { remaining: MAX_DECODED_BUDGET };

  for (const scheme of ENCODED_SCHEMES) {
    // Collect all runs up front (via matchAll) so the inner decode pass — which
    // reuses scheme regexes — can't clobber this loop's lastIndex.
    scheme.re.lastIndex = 0;
    const runs = [...text.matchAll(scheme.re)];
    for (const m of runs) {
      if (budget.remaining <= 0) break;
      const run = m[0];
      const index = m.index ?? 0;
      const decodedViews = iterativeRunViews(scheme, run, budget);
      if (decodedViews.length === 0) continue;

      let name: string | undefined;
      for (const decoded of decodedViews) {
        name = firstMatchNameDerived(decoded);
        if (name) break;
      }
      if (!name) continue;

      out.push({
        type: "obfuscated",
        pattern: `${name} (${scheme.label})`,
        value: run.slice(0, 20) + (run.length > 20 ? "..." : ""),
        masked: maskSecret(run),
        startIndex: index,
        endIndex: index + run.length,
      });
    }
    if (budget.remaining <= 0) break;
  }
  return out;
}

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

function buildNormalizedView(text: string): { normalized: string; outToOrig: number[] } {
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
function scanNormalizedView(
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
function scanKnownValues(
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

/** Scan text for secret patterns */
export function scanForSecrets(text: string): ScanResult {
  const matches: SecretMatch[] = [];

  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(text)) !== null) {
      const value = match[1] || match[0];
      matches.push({
        type: pattern.type,
        pattern: pattern.name,
        value: value.slice(0, 20) + (value.length > 20 ? "..." : ""),
        masked: maskSecret(value),
        startIndex: match.index,
        endIndex: match.index + match[0].length,
      });
    }
  }

  // Build the normalized view once; both the credential-pattern normalized pass
  // and the known-value normalized pass reuse it (one fold + index map per scan).
  const normalizedView = buildNormalizedView(text);

  // Additive evasion-resistant passes: a secret present only in a normalized or
  // decoded view of the text still makes the result NOT clean, with a span that
  // points at the real offending bytes in `text`.
  matches.push(...scanNormalizedView(text, matches, normalizedView));
  matches.push(...scanEncodedViews(text));

  // Known-secret-value pass: a registered stored secret value (raw, encoded, or
  // normalized) makes the scan NOT clean even when it matches no pattern, so the
  // egress guard blocks and the taint path taints on the user's ACTUAL secrets.
  matches.push(...scanKnownValues(text, normalizedView));

  // Additive entropy pass: catch UNKNOWN secrets (random tokens with no
  // recognizable prefix) the catalog can't match. De-duped against catalog
  // matches — only emit for runs not already covered by a known shape so we
  // don't relabel an Anthropic/GitHub key as a generic high-entropy token.
  for (const e of detectHighEntropyTokens(text)) {
    const covered = matches.some(m => m.startIndex < e.endIndex && e.startIndex < m.endIndex);
    if (covered) continue;
    matches.push({
      type: "high-entropy-token",
      pattern: "High-Entropy Token",
      value: e.value.slice(0, 20) + (e.value.length > 20 ? "..." : ""),
      masked: maskSecret(e.value),
      startIndex: e.startIndex,
      endIndex: e.endIndex,
    });
  }

  // Deduplicate by position
  const seen = new Set<string>();
  const deduped = matches.filter(m => {
    const key = `${m.startIndex}:${m.endIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    clean: deduped.length === 0,
    matches: deduped,
    scannedLength: text.length,
  };
}

/** Redact all detected secrets from text */
export function redactSecrets(text: string): string {
  const result = scanForSecrets(text);
  if (result.clean) return text;

  let redacted = text;
  // Process from end to start to maintain indices
  const sorted = [...result.matches].sort((a, b) => b.startIndex - a.startIndex);
  for (const match of sorted) {
    const before = redacted.slice(0, match.startIndex);
    const after = redacted.slice(match.endIndex);
    redacted = before + `[REDACTED:${match.pattern}]` + after;
  }
  return redacted;
}

/** Check if text contains any secrets (quick boolean check) */
export function containsSecrets(text: string): boolean {
  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(text)) return true;
  }
  return false;
}

/**
 * Expand `text` into every view a content-overlap check should inspect: the raw
 * text, its NFKC/homoglyph/control-stripped normalized view, and the decoded
 * payload of each base64/hex/percent-encoded run inside it (one extra layer for
 * double-encoding, matching scanEncodedViews). REUSES the same ENCODED_SCHEMES +
 * buildNormalizedView machinery the scanner's evasion passes use, so a taint
 * overlap check can't drift from the secret scanner on "what counts as the same
 * bytes under encoding." Bounded by MAX_DECODED_BUDGET so a huge payload can't
 * blow up CPU.
 *
 * The raw text is always views[0]; the rest are derived. Callers should treat
 * the strings as content to fingerprint/search — never echo them (a decoded run
 * may itself be a secret).
 */
export function decodedPayloadViews(text: string): string[] {
  const views: string[] = [text];
  if (!text) return views;

  const norm = buildNormalizedView(text).normalized;
  if (norm !== text) views.push(norm);

  const budget: Budget = { remaining: MAX_DECODED_BUDGET };
  for (const scheme of ENCODED_SCHEMES) {
    if (budget.remaining <= 0) break;
    scheme.re.lastIndex = 0;
    for (const m of text.matchAll(scheme.re)) {
      if (budget.remaining <= 0) break;
      // Iteratively peel up to MAX_DECODE_DEPTH layers, surfacing every decoded
      // text view (latin1 + both-endian utf16le for base64/hex; percent text) —
      // the SAME helper scanEncodedViews/scanKnownValues use, so the taint-overlap
      // check can't drift from the scanner on multi-layer encodings.
      for (const v of iterativeRunViews(scheme, m[0], budget)) views.push(v);
    }
  }
  return views;
}

export type { ScanResult };
