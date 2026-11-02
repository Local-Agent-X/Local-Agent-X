/**
 * Secrets Auto-Detection
 *
 * Scans outbound text for API key patterns, credentials,
 * and other secrets before they leave the system.
 *
 * The pattern catalog is NOT defined here — it lives in the canonical
 * credential-patterns.ts (CREDENTIAL_PATTERNS) so the inline redactor and
 * this position-aware scanner can never drift. Add new shapes there.
 *
 * The decode/normalize evasion engine (ReDoS bounds + decode peel) lives in
 * secret-decode-engine.ts; the normalized-view + known-value passes live in
 * secret-normalize.ts. This file is the scan driver and the stable barrel — the
 * public surface (scanForSecrets, redactSecrets,
 * decodedPayloadViews, SecretMatch, ScanResult) is re-exported here unchanged.
 */

import { CREDENTIAL_PATTERNS } from "./credential-patterns.js";
import { detectHighEntropyTokens } from "./entropy-detector.js";
import {
  type SecretMatch,
  maskSecret,
  peelEncodedRuns,
  scanEncodedViews,
} from "./secret-decode-engine.js";
import {
  buildNormalizedView,
  scanNormalizedView,
  scanKnownValues,
} from "./secret-normalize.js";
import { hasKnownSecretValues } from "./known-secrets.js";

export type { SecretMatch };

interface ScanResult {
  clean: boolean;
  matches: SecretMatch[];
  scannedLength: number;
}

/** Does [start, end) overlap any of `spans`? Sorted by start with a running
 *  maximum end, so each question is one binary search. */
function coverageOf(spans: readonly SecretMatch[]): (start: number, end: number) => boolean {
  const sorted = [...spans].sort((a, b) => a.startIndex - b.startIndex);
  const maxEnd: number[] = [];
  for (const m of sorted) maxEnd.push(Math.max(m.endIndex, maxEnd[maxEnd.length - 1] ?? 0));
  return (start, end) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].startIndex < end) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && maxEnd[lo - 1] > start;
  };
}

/** Scan text for secret patterns */
export function scanForSecrets(text: string): ScanResult {
  const matches: SecretMatch[] = [];

  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(text)) !== null) {
      const value = match[1] || match[0];
      // The captured value is the tail of every capturing catalog shape
      // (label, then value), so its last occurrence in the match is its span.
      const valueStart = match.index + match[0].lastIndexOf(value);
      matches.push({
        type: pattern.type,
        pattern: pattern.name,
        value: value.slice(0, 20) + (value.length > 20 ? "..." : ""),
        masked: maskSecret(value),
        startIndex: match.index,
        endIndex: match.index + match[0].length,
        ...(match[1] ? { valueStart, valueEnd: valueStart + value.length } : {}),
        ...(pattern.marker ? { marker: true as const } : {}),
      });
    }
  }

  // Build the normalized view and the decode peel once; the credential, encoded
  // and known-value passes all read them (one fold, one peel per scan).
  const normalizedView = buildNormalizedView(text);
  const peeled = peelEncodedRuns(text);

  // Additive evasion-resistant passes: a secret present only in a normalized or
  // decoded view of the text still makes the result NOT clean, with a span that
  // points at the real offending bytes in `text`. Pushed one by one: a spread of
  // a large match list overflows the call stack.
  for (const m of scanNormalizedView(text, matches, normalizedView)) matches.push(m);
  for (const m of scanEncodedViews(peeled)) matches.push(m);

  // Known-secret-value pass: a registered stored secret value (raw, encoded, or
  // normalized) makes the scan NOT clean even when it matches no pattern, so the
  // egress guard blocks and the taint path taints on the user's ACTUAL secrets.
  for (const m of scanKnownValues(text, normalizedView, peeled)) matches.push(m);

  // Additive entropy pass: catch UNKNOWN secrets (random tokens with no
  // recognizable prefix) the catalog can't match. De-duped against catalog
  // matches — only emit for runs not already covered by a known shape so we
  // don't relabel an Anthropic/GitHub key as a generic high-entropy token.
  // The entropy runs never overlap each other, so the earlier matches are
  // indexed once (a scan over a base64 image yields tens of thousands of runs).
  const covered = coverageOf(matches);
  for (const e of detectHighEntropyTokens(text)) {
    if (covered(e.startIndex, e.endIndex)) continue;
    matches.push({
      type: "high-entropy-token",
      pattern: "High-Entropy Token",
      value: e.value.slice(0, 20) + (e.value.length > 20 ? "..." : ""),
      masked: maskSecret(e.value),
      startIndex: e.startIndex,
      endIndex: e.endIndex,
      valueStart: e.startIndex,
      valueEnd: e.endIndex,
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

/**
 * Only the known-secret-value pass of scanForSecrets: registered values, raw,
 * encoded or normalized. For output whose credential SHAPES are legitimate
 * content (a source file's example key) but where the user's actual secrets
 * must still never appear.
 */
export function scanKnownSecretValues(text: string): SecretMatch[] {
  if (!hasKnownSecretValues()) return [];
  return scanKnownValues(text, buildNormalizedView(text), peelEncodedRuns(text));
}

/**
 * The known-value pass over the given values instead of the registry — raw,
 * encoded or normalized — for secrets that belong to one result only (what a
 * page holds while an evaluate script runs). `pattern` names the matches.
 */
export function scanHeldValues(text: string, held: readonly string[], pattern: string): SecretMatch[] {
  if (held.length === 0) return [];
  return scanKnownValues(text, buildNormalizedView(text), peelEncodedRuns(text), held, pattern);
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

/**
 * Expand `text` into every view a content-overlap check should inspect: the raw
 * text, its NFKC/homoglyph/control-stripped normalized view, and every decoded
 * view of every base64/hex/percent-encoded run inside it, every layer. Reads the
 * scanner's own peel (peelEncodedRuns) and normalized view, so a taint overlap
 * or canary check can't drift from the secret scanner on "what counts as the
 * same bytes under encoding." Bounded by the same input-scaled decode budget.
 * A run that budget could not cover contributes the views it got; the
 * scanner's uninspected match is what fails such a payload closed.
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

  for (const p of peelEncodedRuns(text)) for (const v of p.views) views.push(v);
  return views;
}

export type { ScanResult };
