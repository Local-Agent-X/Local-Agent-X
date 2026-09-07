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
 * public surface (scanForSecrets, redactSecrets, containsSecrets,
 * decodedPayloadViews, SecretMatch, ScanResult) is re-exported here unchanged.
 */

import { CREDENTIAL_PATTERNS } from "./credential-patterns.js";
import { detectHighEntropyTokens } from "./entropy-detector.js";
import {
  type SecretMatch,
  type Budget,
  maskSecret,
  ENCODED_SCHEMES,
  makeScanBudget,
  iterativeRunViews,
  scanEncodedViews,
} from "./secret-decode-engine.js";
import {
  buildNormalizedView,
  scanNormalizedView,
  scanKnownValues,
} from "./secret-normalize.js";

export type { SecretMatch };

interface ScanResult {
  /**
   * True only when the text was FULLY scanned and nothing was found. A scan that
   * hit its decode ceiling and gave up on part of the document is never `clean`
   * — every caller here (http-egress-guard, exfil-scan, phone-projection,
   * bridge-media-forward) reads `clean` as proof of safety and would otherwise
   * let unscanned bytes through silently. See `truncated` to tell the two apart.
   */
  clean: boolean;
  matches: SecretMatch[];
  scannedLength: number;
  /** The decode budget ran out with candidate runs unexamined: not proven clean, gave up. */
  truncated: boolean;
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
  // Each decode pass gets its OWN budget: sharing one would let the catalog pass
  // starve the known-value pass, which is exactly the cross-run starvation being
  // fixed here, only at pass granularity.
  const encodedBudget = makeScanBudget();
  const knownBudget = makeScanBudget();
  matches.push(...scanNormalizedView(text, matches, normalizedView));
  matches.push(...scanEncodedViews(text, encodedBudget));

  // Known-secret-value pass: a registered stored secret value (raw, encoded, or
  // normalized) makes the scan NOT clean even when it matches no pattern, so the
  // egress guard blocks and the taint path taints on the user's ACTUAL secrets.
  matches.push(...scanKnownValues(text, normalizedView, knownBudget));

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

  const truncated = encodedBudget.truncated || knownBudget.truncated;
  return {
    clean: deduped.length === 0 && !truncated,
    matches: deduped,
    scannedLength: text.length,
    truncated,
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

  // Per-run bounded (so one expensive run can't starve the rest of the document)
  // and `continue`, not `break`, at the scan ceiling.
  const budget: Budget = makeScanBudget();
  for (const scheme of ENCODED_SCHEMES) {
    scheme.re.lastIndex = 0;
    for (const m of text.matchAll(scheme.re)) {
      if (budget.remaining <= 0) { budget.truncated = true; continue; }
      // Iteratively peel every encoding layer (budget-bounded), surfacing every
      // decoded text view (latin1 + both-endian utf16le for base64/hex; percent
      // text) —
      // the SAME helper scanEncodedViews/scanKnownValues use, so the taint-overlap
      // check can't drift from the scanner on multi-layer encodings.
      for (const v of iterativeRunViews(scheme, m[0], budget)) views.push(v);
    }
  }
  return views;
}

export type { ScanResult };
