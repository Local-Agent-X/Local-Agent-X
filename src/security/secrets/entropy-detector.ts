/**
 * Shannon-entropy detector for UNKNOWN secrets.
 *
 * Regex/known-shape detection (credential-patterns.ts) only catches secrets
 * with a recognizable prefix or surrounding keyword. It misses a bare random
 * token — e.g. a 40-char base64 API key with no `sk-`/`ghp_`/`AKIA` marker.
 * This pass flags contiguous high-entropy runs that look like raw key material.
 *
 * ── FP/FN tradeoff (read before tuning) ──────────────────────────────────────
 * A false positive here BLOCKS A LEGITIMATE EGRESS (this feeds the http egress
 * guard via scanForSecrets), so the bias is hard toward NOT flagging. We accept
 * false NEGATIVES to buy that: a run is flagged ONLY when every guard below
 * holds, and several benign-but-high-entropy shapes are explicitly excluded
 * even though a real secret could (rarely) wear the same costume:
 *   - UUIDs (8-4-4-4-12) — ubiquitous IDs, not secrets.
 *   - Git SHA-1 (40 hex), MD5 (32 hex), SHA-256 (64 hex) — content hashes. Yes,
 *     a 64-hex *could* be a real secret; we skip it to keep FP near zero. That
 *     is a deliberate FN: a hex secret of exactly hash length sails through.
 *   - lowercase-only-alphanumeric runs (no uppercase) — opaque IDs like macOS
 *     temp-dir names, nanoids, and slugs, NOT secrets. A real base64-alphabet
 *     secret almost always mixes case; requiring mixed case removes this whole
 *     benign-ID FP class (FN: an all-lowercase secret slips, accepted).
 *   - base64 that decodes to mostly-printable text — i.e. base64-OF-PROSE. Per
 *     bits/char alone this is indistinguishable from a real token (b64 of
 *     English ~4.4 bits/char), so we decode and skip runs that round-trip to
 *     >85% printable ASCII. Real key material decodes to high-binary bytes
 *     (~40-50% printable). FN accepted: a secret that happens to be base64 of
 *     printable text slips through (rare for raw key bytes).
 * The thresholds (length floors + bits/char) are set ABOVE where natural
 * language, file paths, CSS/minified-code soup land, so those stay clean. They
 * are intentionally conservative, not maximally sensitive — known-shape
 * detection remains the primary control.
 */

export interface EntropyMatch {
  startIndex: number;
  endIndex: number;
  value: string;
}

// Length floors. A real random base64 token is >=24 chars; hex key material is
// >=32 nibbles (128-bit). Shorter runs are too cheap to brute-force-distinguish
// from words/IDs and are the bulk of FP risk, so they're below the floor.
const MIN_BASE64_LEN = 24;
const MIN_HEX_LEN = 32;

// Bits/char thresholds. Max entropy is log2(alphabet): ~6 for base64-ish (64
// symbols), 4 for hex (16 symbols). Natural text and most identifiers sit well
// under these; random key material sits near the ceiling. base64-ish at >=4.0
// and hex at >=3.0 cleanly separates secrets from prose/paths/CSS in practice.
const MIN_BASE64_ENTROPY = 4.0;
const MIN_HEX_ENTROPY = 3.0;

// base64url-ish run: a contiguous body of [A-Za-z0-9_-] with `=` only as
// TRAILING padding. NOTE the deliberate omission of `+` and `/`:
//   - `=` out of the body means a `word=blob` pair (e.g. `note=aGVs…`) splits
//     into `word` + `blob`, so the payload is decoded/measured on its own.
//   - `/` out of the body means a file path (`src/security/foo`) is NOT captured
//     as one giant run — paths were the worst FP source. Standard-base64 tokens
//     that contain `/`/`+` get split here (accepted FN: real tokens are
//     overwhelmingly base64url or bare alphanumeric, which this still catches).
// Hex is handled separately so a pure-hex run uses the hex floor/threshold.
const BASE64_RUN_RE = /[A-Za-z0-9_-]{20,}={0,2}/g;
const HEX_RUN_RE = /\b[0-9a-fA-F]{24,}\b/g;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Shannon entropy in bits per character of `s`. */
function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  const n = s.length;
  for (const count of freq.values()) {
    const p = count / n;
    bits -= p * Math.log2(p);
  }
  return bits;
}

// Hash lengths we deliberately skip (git SHA-1=40, MD5=32, SHA-256=64). Listed
// so the intent is explicit; see the FN note in the file header.
const HASH_HEX_LENGTHS = new Set([32, 40, 64]);

function isExcludedHex(run: string): boolean {
  if (HASH_HEX_LENGTHS.has(run.length)) return true;
  return false;
}

// Fraction of decoded bytes that are printable ASCII above which we treat a
// base64 run as encoded TEXT (prose), not raw key material. Real random key
// bytes land near 0.4; English text round-trips to ~1.0.
const PRINTABLE_TEXT_RATIO = 0.85;

function printableRatio(buf: Buffer): number {
  if (buf.length === 0) return 1;
  let printable = 0;
  for (const b of buf) {
    // Printable ASCII range plus common whitespace (tab/newline/return).
    if ((b >= 0x20 && b <= 0x7e) || b === 0x09 || b === 0x0a || b === 0x0d) printable++;
  }
  return printable / buf.length;
}

// A kebab/snake/path slug: 3+ segments split on `-` `_` `/` `.` that are each
// purely lowercase-alphanumeric (no uppercase, no `+`/`/`). Real base64url key
// material effectively never wears this costume — across 50k random tokens,
// zero matched — but human-readable slugs (`sk-supplement-formula-2026-batch`)
// and lowercase file paths (`src/security/credential-patterns.ts`, captured as
// one run because `/` is a base64 char) do, and their per-char entropy clears
// the threshold. Excluding them kills the slug/path FP that bricked agent runs.
function isSlug(run: string): boolean {
  const parts = run.split(/[-_/.]/);
  if (parts.length < 3) return false;
  return parts.every(p => p.length > 0 && /^[a-z0-9]+$/.test(p));
}

function isExcludedBase64(run: string): boolean {
  // UUIDs contain `-`, so they surface in the base64-ish run; exclude them.
  if (UUID_RE.test(run)) return true;
  if (isSlug(run)) return true;
  // Require MIXED CASE. A secret drawn from the base64(url) alphabet (62+
  // symbols) almost always contains both an uppercase and a lowercase letter —
  // across 5k random 40/48-char tokens, every one did. Lowercase-only-
  // alphanumeric runs are the dominant benign-ID shape (macOS temp-dir names
  // like `4xyfdz795ms8x8dqkyzhhnf40000gn`, nanoids, hash-ish ids) and sit just
  // over the entropy floor, so they were the residual FP source. Excluding them
  // accepts the FN of an all-lowercase secret — a worthwhile trade for not
  // blocking egress on every opaque lowercase id.
  if (!(/[a-z]/.test(run) && /[A-Z]/.test(run))) return true;
  // base64-of-prose: if the run is valid base64 and decodes to mostly-printable
  // text, it's encoded natural-language content, not a secret. See header.
  const normalized = run.replace(/-/g, "+").replace(/_/g, "/");
  const unpadded = normalized.replace(/=+$/, "");
  if (/^[A-Za-z0-9+/]+$/.test(unpadded)) {
    try {
      const buf = Buffer.from(normalized, "base64");
      if (buf.length > 0 && buf.toString("base64").replace(/=+$/, "") === unpadded) {
        if (printableRatio(buf) >= PRINTABLE_TEXT_RATIO) return true;
      }
    } catch {
      // Not decodable as base64 — fall through; treat as a candidate.
    }
  }
  return false;
}

/**
 * Find high-entropy runs that look like raw key material and aren't a known
 * benign shape. Additive and conservative — see the file header for the
 * FP/FN reasoning. Spans are real offsets into `text`.
 */
export function detectHighEntropyTokens(text: string): EntropyMatch[] {
  const out: EntropyMatch[] = [];

  HEX_RUN_RE.lastIndex = 0;
  for (const m of text.matchAll(HEX_RUN_RE)) {
    const run = m[0];
    const index = m.index ?? 0;
    if (run.length < MIN_HEX_LEN) continue;
    if (isExcludedHex(run)) continue;
    if (shannonEntropy(run) < MIN_HEX_ENTROPY) continue;
    out.push({ startIndex: index, endIndex: index + run.length, value: run });
  }

  BASE64_RUN_RE.lastIndex = 0;
  for (const m of text.matchAll(BASE64_RUN_RE)) {
    const run = m[0];
    const index = m.index ?? 0;
    if (run.length < MIN_BASE64_LEN) continue;
    // A pure-hex run is already considered by the hex pass with its own
    // (stricter-length, lower-entropy) rules; don't double-count it here.
    if (/^[0-9a-fA-F]+$/.test(run)) continue;
    if (isExcludedBase64(run)) continue;
    if (shannonEntropy(run) < MIN_BASE64_ENTROPY) continue;
    out.push({ startIndex: index, endIndex: index + run.length, value: run });
  }

  return out;
}
