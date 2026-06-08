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

function decodeBase64(run: string): string | null {
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
    return buf.toString("latin1");
  } catch {
    return null;
  }
}

function decodeHex(run: string): string | null {
  if (run.length < MIN_HEX_RUN || run.length % 2 !== 0) return null;
  try {
    const buf = Buffer.from(run, "hex");
    if (buf.length === 0 || buf.length * 2 !== run.length) return null;
    return buf.toString("latin1");
  } catch {
    return null;
  }
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

const ENCODED_SCHEMES: EncodedScheme[] = [
  { re: BASE64_RUN_RE, decode: decodeBase64, label: "base64" },
  { re: HEX_RUN_RE, decode: decodeHex, label: "hex" },
  { re: PERCENT_RUN_RE, decode: decodePercent, label: "percent" },
];

/**
 * Find encoded runs whose DECODED view trips a credential pattern, and return a
 * SecretMatch per offending run that spans the ORIGINAL encoded blob (so
 * redaction removes the whole thing). Decodes at most one extra layer to catch
 * a single round of double-encoding. Bounded by MAX_DECODED_BUDGET.
 */
function scanEncodedViews(text: string): SecretMatch[] {
  const out: SecretMatch[] = [];
  let budget = MAX_DECODED_BUDGET;

  for (const scheme of ENCODED_SCHEMES) {
    // Collect all runs up front (via matchAll) so the inner double-decode pass
    // — which reuses scheme regexes — can't clobber this loop's lastIndex.
    scheme.re.lastIndex = 0;
    const runs = [...text.matchAll(scheme.re)];
    for (const m of runs) {
      if (budget <= 0) break;
      const run = m[0];
      const index = m.index ?? 0;
      const decoded = scheme.decode(run);
      if (decoded === null) continue;
      budget -= decoded.length;

      let name = firstMatchName(decoded);
      // One extra layer: a base64-of-base64 (or base64-of-hex) wrapper. Use a
      // fresh regex per scheme so no shared lastIndex state leaks.
      if (!name) {
        for (const inner of ENCODED_SCHEMES) {
          const fresh = new RegExp(inner.re.source, inner.re.flags);
          const im = fresh.exec(decoded);
          if (!im) continue;
          const innerDecoded = inner.decode(im[0]);
          if (innerDecoded === null) continue;
          budget -= innerDecoded.length;
          name = firstMatchName(innerDecoded);
          if (name) break;
        }
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
    if (budget <= 0) break;
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
function buildNormalizedView(text: string): { normalized: string; outToOrig: number[] } {
  let normalized = "";
  const outToOrig: number[] = []; // normalized char index → original text index
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (stripControlChars(ch) === "") continue; // control / zero-width → dropped
    const folded = normalizeHomoglyphs(ch).normalize("NFKC");
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
  for (const scheme of ENCODED_SCHEMES) {
    scheme.re.lastIndex = 0;
    for (const m of text.matchAll(scheme.re)) {
      const run = m[0];
      const index = m.index ?? 0;
      const decoded = scheme.decode(run);
      if (decoded === null) continue;
      if (values.some((v) => decoded.includes(v))) {
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

  let budget = MAX_DECODED_BUDGET;
  for (const scheme of ENCODED_SCHEMES) {
    if (budget <= 0) break;
    scheme.re.lastIndex = 0;
    for (const m of text.matchAll(scheme.re)) {
      if (budget <= 0) break;
      const decoded = scheme.decode(m[0]);
      if (decoded === null) continue;
      budget -= decoded.length;
      views.push(decoded);
      // One extra layer (base64-of-base64 / base64-of-hex), as scanEncodedViews.
      for (const inner of ENCODED_SCHEMES) {
        const fresh = new RegExp(inner.re.source, inner.re.flags);
        const im = fresh.exec(decoded);
        if (!im) continue;
        const innerDecoded = inner.decode(im[0]);
        if (innerDecoded === null) continue;
        budget -= innerDecoded.length;
        views.push(innerDecoded);
      }
    }
  }
  return views;
}

export type { ScanResult };
