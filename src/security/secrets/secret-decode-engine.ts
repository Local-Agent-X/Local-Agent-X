/**
 * Secret scanner — decode/normalize evasion engine.
 *
 * The ReDoS-bounded decode pipeline (run regexes, byte budget, depth cap, and the
 * iterativeRunViews peel loop they guard) plus the anchor-relaxed derived-view
 * catalog and the encoded-view credential pass. These bounds are security
 * load-bearing and live together so a bound can never be split away from the loop
 * it guards. Consumed by secret-normalize.ts (known-value pass) and the scan
 * driver in secret-scanner.ts.
 */

import { CREDENTIAL_PATTERNS } from "./credential-patterns.js";

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

export interface EncodedScheme {
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

export const ENCODED_SCHEMES: EncodedScheme[] = [
  { re: BASE64_RUN_RE, decode: decodeBase64, label: "base64" },
  { re: HEX_RUN_RE, decode: decodeHex, label: "hex" },
  { re: PERCENT_RUN_RE, decode: decodePercent, label: "percent" },
];

// C3-18: a fixed one-extra-layer peel let `base64(base64(hex(secret)))` (3
// layers) sail through clean — defeating the scanner AND the canary gate. The
// peel below iterates layer-by-layer with NO fixed depth cap: a secret wrapped
// in an arbitrary number of encoding layers is still reached. Total work is
// bounded SOLELY by the shared MAX_DECODED_BUDGET byte counter (threaded through
// every layer/view), which is sufficient for DoS safety — a nested
// decompression-bomb input draws the budget to zero and the loop terminates. A
// redundant fixed depth cap was removed because it was only an evasion gap (a
// >5-layer wrap stopped early even with budget left), never the DoS bound.

// Mutable byte-budget cell so one counter is shared across every layer and view
// of every run in a single scan (not per-run), matching the original
// MAX_DECODED_BUDGET intent.
export interface Budget {
  remaining: number;
}

// Per-view, per-scheme cap on how many inner encoded runs may be enqueued.
// CHOSEN BY MEASUREMENT, not taste, on this repo's corpus (3751 files, 45.5MB)
// and on adversarial padded documents:
//   - Inner-run counts per (view, scheme): p50=0, p90=1, p99=1, p99.9=226,
//     max=4513. 256 covers p99.9, so ordinary content is enumerated in full.
//   - Evasion: a padded object hides the real blob iff it sits past the cap.
//     Filler runs tolerated before a wrapped key is missed — cap 4: 0, cap 8: 4,
//     cap 64: 16, cap 256: 16. Past ~64 the shared byte budget, not the cap, is
//     the binding limit, so raising it further buys nothing.
//   - Cost: whole-corpus scan 12.7s at cap 1 (the old first-run-only behavior)
//     vs 12.6s at cap 256, same 472 not-clean files; the pathological
//     thousands-of-16-char-tokens document is unchanged (40ms raw / 0.47s
//     base64-wrapped). Flat because the byte budget already bounds decode work.
// The cap is a WORK and QUEUE-MEMORY bound (256 runs per scheme per view), not
// the security bound — MAX_DECODED_BUDGET is that.
const MAX_INNER_RUNS_PER_VIEW = 256;

/**
 * Iteratively peel an outer encoded run into EVERY decoded text view across any
 * number of layers, sharing one byte budget. A worklist loop: take a view
 * string, re-detect the inner encoded runs inside it, and enqueue those runs'
 * decode views for a later round. Every view we produce (latin1, both-endian
 * utf16le, percent text, at every layer) is yielded for the caller to scan. The
 * SINGLE source of "what bytes can be recovered from this run" —
 * scanEncodedViews, scanKnownValues, and decodedPayloadViews all consume it so
 * the catalog pass, the known-value pass, and the taint-overlap check can never
 * drift on encoding handling. Bounded by `budget`.
 *
 * ALL inner runs are enumerated per scheme per view, not just the first: a run
 * regex matches the FIRST candidate in the view, so sixteen characters of filler
 * ("aaaaaaaaaaaaaaaa" is a valid BASE64_RUN_RE match) used to consume the
 * scheme's only slot and the real blob was never enqueued — one padded object
 * defeated the scanner, the taint overlap check and the canary tripwire at once.
 *
 * PRIORITY, not just a queue. Enumerating siblings draws on the SAME shared
 * MAX_DECODED_BUDGET, so naive enumeration lets filler runs spend the budget
 * before the deeper layers of the real blob are reached — measured: an 8 x 8KB
 * filler object around a 3-layer-wrapped key went FOUND -> MISSED. Each item
 * therefore carries a penalty = its parent's penalty + its index within its
 * (view, scheme) enumeration, and buckets are drained in ascending penalty
 * order. Penalty 0 is exactly the chain the first-run-only code walked, and a
 * child's penalty is never below its parent's, so the whole old traversal is
 * materialized BEFORE any newly-enumerated sibling is charged a single byte:
 * enumeration can only ADD detections, never starve one that already worked.
 */
export function iterativeRunViews(
  outerScheme: EncodedScheme,
  outerRun: string,
  budget: Budget
): string[] {
  const collected: string[] = [];
  type Item = { run: string; scheme: EncodedScheme };
  // buckets[p] = items deferred by penalty p. Seeded with the outer run at 0.
  const buckets: Array<Item[] | undefined> = [[{ run: outerRun, scheme: outerScheme }]];
  // No fixed depth cap: peel until every bucket drains or the shared byte budget
  // is spent. budget.remaining > 0 is the SOLE termination bound — DoS-safe, and
  // a deeper wrap can no longer evade the scan by exceeding a layer count. The
  // penalty cursor only moves forward (a child's penalty >= its parent's).
  for (let penalty = 0; penalty < buckets.length && budget.remaining > 0; penalty++) {
    const bucket = buckets[penalty];
    if (!bucket) continue;
    // The bucket grows while it is walked (penalty-0 children land in it); the
    // length check re-reads it each step so those are processed in FIFO order.
    for (let i = 0; i < bucket.length && budget.remaining > 0; i++) {
      const views = runDecodeViews(bucket[i].scheme, bucket[i].run);
      for (const v of views) {
        if (budget.remaining <= 0) break;
        // Charge the budget for EVERY materialized view across ALL layers (not
        // just the primary view of each decode) so multi-view x multi-layer
        // amplification is fully counted — this is what bounds a nested
        // decompression-bomb input: each ~N-byte view we produce (and will scan)
        // draws down the shared MAX_DECODED_BUDGET, so total bytes produced AND
        // scanned across the whole peel can't exceed it.
        budget.remaining -= v.length;
        collected.push(v);
        // Enqueue the inner encoded runs of this view for a later round.
        // Fresh regex per scheme so no shared lastIndex state leaks.
        for (const inner of ENCODED_SCHEMES) {
          const fresh = new RegExp(inner.re.source, inner.re.flags);
          let im: RegExpExecArray | null;
          for (let n = 0; n < MAX_INNER_RUNS_PER_VIEW && (im = fresh.exec(v)) !== null; n++) {
            const p = penalty + n;
            (buckets[p] ??= []).push({ run: im[0], scheme: inner });
          }
        }
      }
    }
  }
  return collected;
}

/**
 * Find encoded runs whose DECODED view trips a credential pattern, and return a
 * SecretMatch per offending run that spans the ORIGINAL encoded blob (so
 * redaction removes the whole thing). Iteratively peels every encoding layer (so
 * multi-round encodings like base64(base64(hex(secret))) are caught), bounded
 * solely by the shared MAX_DECODED_BUDGET byte budget. Derived views are matched with the
 * anchor-relaxed catalog (firstMatchNameDerived) so a synthetic prefix byte
 * can't hide a key behind a broken `\b`.
 */
export function scanEncodedViews(text: string): SecretMatch[] {
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

export { MAX_DECODED_BUDGET };
