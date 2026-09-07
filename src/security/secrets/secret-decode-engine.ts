/**
 * Secret scanner — decode/normalize evasion engine.
 *
 * The ReDoS bounds — the scan-wide byte budget and its per-run slice — and the
 * iterativeRunViews peel loop they guard, plus the anchor-relaxed derived-view
 * catalog, the encoded-view credential pass, and its span attribution. The
 * bounds and the loop live together so a bound can never be split away from the
 * loop it guards; what counts as an encoded run and how each scheme decodes
 * lives in secret-decode-schemes.ts. Consumed by secret-normalize.ts
 * (known-value pass) and the driver in secret-scanner.ts.
 */

import { CREDENTIAL_PATTERNS } from "./credential-patterns.js";
import {
  type EncodedScheme,
  ENCODED_SCHEMES,
  runDecodeViews,
  percentDecodeWithMap,
} from "./secret-decode-schemes.js";

// Re-exported so consumers keep importing the decode surface from one place.
export { ENCODED_SCHEMES };
export type { EncodedScheme };

export interface SecretMatch {
  type: string;
  pattern: string;
  value: string;
  masked: string;
  startIndex: number;
  endIndex: number;
}

export function maskSecret(value: string): string {
  if (value.length <= 8) return "***";
  return value.slice(0, 4) + "***" + value.slice(-4);
}

// ── Decode/normalize evasion defense ──────────────────────────────────────
//
// scanForSecrets matches the credential catalog against the RAW text. An
// attacker (or a compromised model) can evade that by encoding the secret:
// base64("sk-ant-…") or its hex/percent-encoded forms sail past a raw regex. The
// passes below detect a secret that is present only in a DECODED or NORMALIZED
// view of the text. Detection (the `clean` flag) is the must-have; for redaction
// we attribute the match to a span in the ORIGINAL text (see attributedSpan) so
// redactSecrets / redactSecretSpans strip something real — never a span that
// points into a derived string that doesn't exist in the caller's text.

// Only credential-pattern matches count — no entropy heuristics — so random
// base64 that decodes to garbage stays clean (near-zero new false positives).

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

// Name of the first credential pattern a DERIVED view trips, for the label. Uses
// the anchor-relaxed catalog so a synthetic prefix byte can't hide a key.
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
// Per-RUN slice of that budget. The scan-wide ceiling alone was a STARVATION
// hazard, not just a DoS ceiling: one expensive run could draw the shared
// counter to zero and every LATER run went unscanned, so the scanner failed OPEN
// and SILENT on the rest of the document. A run may now spend at most 1/16 of
// the scan budget, so at least 16 distinct runs always have budget; the global
// cap remains the DoS ceiling. 1/16 = 16 KiB is far more than any real
// credential needs: every decode SHRINKS its input (base64 3/4, hex 1/2) and
// each layer yields ~3 views, so 16 KiB fully peels a ~1.3 KB outer blob.
const MAX_RUN_DECODED_BUDGET = MAX_DECODED_BUDGET / 16;

// C3-18: a fixed one-extra-layer peel let `base64(base64(hex(secret)))` (3
// layers) sail through clean — defeating the scanner AND the canary gate. The
// peel below iterates layer-by-layer with NO fixed depth cap: a secret wrapped
// in an arbitrary number of encoding layers is still reached. Total work is
// bounded SOLELY by the byte counters (threaded through every layer/view), which
// is sufficient for DoS safety — a nested decompression-bomb input draws the
// budget to zero and the loop terminates. A redundant fixed depth cap was
// removed because it was only an evasion gap (a >5-layer wrap stopped early even
// with budget left), never the DoS bound.

// Mutable byte-budget cell: one counter shared across every layer and view of
// every run in a single scan, plus a per-run slice taken from it inside the loop
// so no one run can spend the whole scan's allowance.
export interface Budget {
  remaining: number;
  /**
   * Set once the SCAN-WIDE ceiling is reached with candidate runs still
   * unexamined — i.e. part of the document was never scanned. A pass that sets
   * this did NOT prove the text clean, it gave up; callers that read `clean` as
   * proof of safety must distinguish the two.
   */
  truncated: boolean;
}

export function makeScanBudget(): Budget {
  return { remaining: MAX_DECODED_BUDGET, truncated: false };
}

/**
 * Iteratively peel an outer encoded run into EVERY decoded text view across any
 * number of layers. A worklist/queue loop: at each layer, take a view string,
 * re-detect any inner encoded run inside it, and enqueue that run's decode views
 * for the next layer. Every view we produce (latin1, both-endian utf16le,
 * percent text, at every layer) is yielded for the caller to scan. The SINGLE
 * source of "what bytes can be recovered from this run" — scanEncodedViews,
 * scanKnownValues, and decodedPayloadViews all consume it so the catalog pass,
 * the known-value pass, and the taint-overlap check can never drift on encoding
 * handling. Bounded by the scan-wide `budget` AND by this run's slice of it.
 */
export function iterativeRunViews(
  outerScheme: EncodedScheme,
  outerRun: string,
  budget: Budget
): string[] {
  const collected: string[] = [];
  // Queue of (runString, scheme) to decode. Seed with the outer run.
  const queue: Array<{ run: string; scheme: EncodedScheme }> = [
    { run: outerRun, scheme: outerScheme },
  ];
  // TWO bounds, both required. `runRemaining` is this run's own slice of the
  // scan budget: it stops one expensive run from starving every later run in the
  // document. `budget.remaining` remains the scan-wide DoS ceiling. No fixed
  // depth cap: peel until the queue drains or a bound is spent, so a deeper wrap
  // can't evade the scan by exceeding a layer count.
  let runRemaining = Math.min(MAX_RUN_DECODED_BUDGET, budget.remaining);
  while (queue.length > 0 && runRemaining > 0) {
    const nextLayer: Array<{ run: string; scheme: EncodedScheme }> = [];
    for (const item of queue) {
      if (runRemaining <= 0) break;
      const views = runDecodeViews(item.scheme, item.run);
      if (views.length === 0) continue;
      for (const v of views) {
        if (runRemaining <= 0) break;
        // Charge BOTH counters for EVERY materialized view across ALL layers
        // (not just the primary view of each decode) so multi-view × multi-layer
        // amplification is fully counted — this is what bounds a nested
        // decompression-bomb input: each ~N-byte view we produce (and will scan)
        // draws down both, so total bytes produced AND scanned across the whole
        // peel can't exceed either bound.
        budget.remaining -= v.length;
        runRemaining -= v.length;
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
  }
  return collected;
}

/**
 * Find encoded runs whose DECODED view trips a credential pattern, and return a
 * SecretMatch per offending run spanning the original encoded bytes (see
 * attributedSpan). Iteratively peels every encoding layer, so multi-round
 * encodings like base64(base64(hex(secret))) are caught. Derived views use the
 * anchor-relaxed catalog so a synthetic prefix byte can't hide a key behind a
 * broken `\b`. `budget` is shared across every run of the scan.
 */
export function scanEncodedViews(text: string, budget: Budget = makeScanBudget()): SecretMatch[] {
  const out: SecretMatch[] = [];

  for (const scheme of ENCODED_SCHEMES) {
    // Collect all runs up front (via matchAll) so the inner decode pass — which
    // reuses scheme regexes — can't clobber this loop's lastIndex.
    scheme.re.lastIndex = 0;
    const runs = [...text.matchAll(scheme.re)];
    for (const m of runs) {
      // `continue`, never `break`: exhausting the scan budget on run A must not
      // silently skip run B (and every run after it) — that made the scanner
      // report clean on documents it never looked at. When the ceiling really is
      // reached we record it so the result can say "gave up", not "clean".
      if (budget.remaining <= 0) { budget.truncated = true; continue; }
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

      const [start, end] = attributedSpan(scheme, run, index, budget);
      out.push({
        type: "obfuscated",
        pattern: `${name} (${scheme.label})`,
        value: run.slice(0, 20) + (run.length > 20 ? "..." : ""),
        masked: maskSecret(run),
        startIndex: start,
        endIndex: end,
      });
    }
  }
  return out;
}

/**
 * Where in `text` a tripping run is blamed. For base64/hex the run IS the
 * encoded blob (charset-restricted), so the whole run is right. For percent the
 * "run" is any whitespace-free stretch — a whole minified document — and blaming
 * all of it made redactSecrets overwrite the document instead of the credential;
 * so percent decodes with an index map and blames only the offending region.
 * Falls back to the whole run when that region isn't recoverable, so the span
 * always CONTAINS the credential and redaction can never leave it behind.
 */
function attributedSpan(
  scheme: EncodedScheme,
  run: string,
  index: number,
  budget: Budget
): [number, number] {
  const whole: [number, number] = [index, index + run.length];
  if (scheme.label !== "percent") return whole;
  const pm = percentDecodeWithMap(run);
  if (!pm) return whole;
  const region = offendingRegion(pm.text, budget);
  if (!region) return whole;
  const start = pm.map[region[0]] ?? 0;
  const end = pm.map[region[1]] ?? run.length;
  return end > start ? [index + start, index + end] : whole;
}

/** Span within a decoded text of the credential, or of the inner encoded run that decodes to one. */
function offendingRegion(text: string, budget: Budget): [number, number] | null {
  for (const p of DERIVED_VIEW_PATTERNS) {
    p.regex.lastIndex = 0;
    const m = p.regex.exec(text);
    p.regex.lastIndex = 0;
    if (m) return [m.index, m.index + m[0].length];
  }
  for (const scheme of ENCODED_SCHEMES) {
    const re = new RegExp(scheme.re.source, scheme.re.flags); // all schemes are /g
    for (const m of text.matchAll(re)) {
      if (iterativeRunViews(scheme, m[0], budget).some((v) => firstMatchNameDerived(v))) {
        return [m.index ?? 0, (m.index ?? 0) + m[0].length];
      }
    }
  }
  return null;
}

export { MAX_DECODED_BUDGET, MAX_RUN_DECODED_BUDGET };
