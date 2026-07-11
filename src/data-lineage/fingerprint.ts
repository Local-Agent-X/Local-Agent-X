/**
 * Data Lineage — content fingerprints (stateless)
 *
 * The privacy-preserving content-overlap primitive used by the taint registry:
 * SHA-256 hashes of normalized char-window shingles. No plaintext is ever
 * stored; a later egress check intersects recorded shingle hashes against a
 * payload's hashes to prove which tainted bytes appear outbound.
 */

import { createHash } from "node:crypto";

export type TaintSource = "sensitive_file" | "secret" | "memory" | "web" | "user_data";

export interface TaintEntry {
  source: TaintSource;
  target: string;     // file path, secret name, URL, etc.
  timestamp: number;
  runId: string;
  // Content fingerprints: SHA-256 hashes (truncated) of normalized content
  // shingles, captured at read time. Privacy-preserving — NO plaintext is
  // stored. They let a later egress check prove which tainted bytes appear in
  // an outbound payload (findTaintInPayload) WITHOUT keeping the raw content.
  // Empty when the read carried no content (3-arg back-compat call sites).
  fingerprints: string[];
  // COMPLETENESS GUARD (the core B+ safety property). true iff `fingerprints`
  // provably cover the ENTIRE recorded content — the shingling reached content
  // end BEFORE hitting the bounded fingerprint cap. false when the content was
  // too large to fully fingerprint (only a HEAD window is covered) OR carried no
  // fingerprintable content at all. An egress may be CLEARED (contribute to
  // blocked:false) ONLY by an entry that is both fingerprinted AND complete: for
  // an incomplete entry, "payload does not overlap the fingerprints" proves only
  // that the covered HEAD is absent, NOT that the unfingerprinted tail is — so
  // such an entry keeps the hard presence-floor block regardless of payload.
  complete: boolean;
}

/** Result of fingerprinting a piece of content: the shingle hashes plus whether
 *  they cover the WHOLE content (see TaintEntry.complete). */
export interface FingerprintResult {
  fingerprints: string[];
  complete: boolean;
}

// ── Content fingerprints ───────────────────────────────────────────────────
//
// A fingerprint is the SHA-256 of a normalized content SHINGLE (a fixed-length
// window of the content). Overlapping shingles mean a CHUNK of the sensitive
// content — not just the whole blob — can be detected in a payload, even after
// it's been sliced, reflowed, or partially quoted. We never store plaintext;
// only the hashes, capped per entry. Matching is exact-hash, so a hit is a real
// content overlap (near-zero false positives) — random text won't collide.

// Char-window shingle width. Wide enough that a window is unlikely to recur in
// unrelated prose (no false match), narrow enough that a quoted chunk of the
// secret still produces at least one shared window.
const SHINGLE_WIDTH = 24;
// Step between shingle starts. < width so windows overlap (a chunk that doesn't
// align to a window boundary still shares one). 8 keeps the count bounded.
const SHINGLE_STEP = 8;
// Coverage budget: the max normalized-char prefix a single entry can FULLY
// fingerprint (and thus be marked `complete`). Raised well above the old
// head-only window so typical small configs (a config line, a short dotfile,
// a few-KB file) are fully coverable — that is what lets B+ clear a
// provably-unrelated payload without over-blocking. Still bounded: content
// longer than this is HEAD-fingerprinted but marked INCOMPLETE (never
// "complete"), so a large key/credential/kubeconfig stays UNCLEARABLE and its
// tail can never egress by evading the head window.
const MAX_FINGERPRINT_CHARS = 1024;
// Max fingerprints kept per entry, derived from the coverage budget: enough
// sparse (step-SHINGLE_STEP) windows to span MAX_FINGERPRINT_CHARS, +1 for the
// tail window. Memory bound: ~129 * 16 hex chars ≈ 2KB per entry — still small.
// This count is the REAL completeness limiter: hitting it before content end
// means the content was too large to fully cover → incomplete.
const MAX_FINGERPRINTS = Math.ceil(MAX_FINGERPRINT_CHARS / SHINGLE_STEP) + 1;
// Hard cap on raw content bytes normalized/hashed at all — a second bound so a
// pathologically repetitive multi-MB read (whose distinct-shingle count stays
// tiny, never tripping MAX_FINGERPRINTS) still can't run unbounded. Content
// longer than this is truncated, and a truncated content can NEVER be complete.
const MAX_FINGERPRINT_CONTENT = 64 * 1024;
// Truncated digest length (hex chars). 16 hex = 64 bits — collision-safe for the
// handful of shingles we store while halving memory vs a full digest.
const FP_DIGEST_HEX = 16;

// Collapse whitespace runs so reflowed/indented copies of the same bytes still
// hash equal; lowercase for case-insensitive overlap on prose-y content. Applied
// to BOTH the recorded content and the payload views before shingling.
function normalizeForFingerprint(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function shingleHash(window: string): string {
  return createHash("sha256").update(window).digest("hex").slice(0, FP_DIGEST_HEX);
}

// Shingle `norm` into window hashes at the given step, capped at `max` DISTINCT
// hashes. Also reports `complete`: whether shingling reached content end BEFORE
// the cap became the limiter. `complete:false` means a full additional window
// still fit when the cap was reached — i.e. content beyond the covered region is
// NOT fingerprinted. (Highly repetitive content whose distinct-hash count never
// reaches the cap is `complete:true` — one hash genuinely covers every identical
// window, so the whole content IS provably covered.)
function shingleHashes(norm: string, step: number, max: number): { hashes: Set<string>; complete: boolean } {
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE_WIDTH <= norm.length; i += step) {
    // A full window still fits here but the budget is spent → the tail from this
    // position on is uncovered → incomplete.
    if (out.size >= max) return { hashes: out, complete: false };
    out.add(shingleHash(norm.slice(i, i + SHINGLE_WIDTH)));
  }
  // Loop exited because no further full window fits → every window that could
  // exist was hashed → the content is fully covered (the <SHINGLE_WIDTH tail
  // that remains can't form a standalone window and can't egress on its own).
  return { hashes: out, complete: true };
}

/**
 * Compute content fingerprints for sensitive content: hashes of normalized
 * char-window shingles at SHINGLE_STEP (sparse — keeps the stored set bounded by
 * MAX_FINGERPRINTS), plus a `complete` flag stating whether those shingles cover
 * the WHOLE content. Returns `{ fingerprints: [], complete: false }` for
 * empty/too-short content (nothing a single window could cover) so a short read
 * just records provenance, not a fingerprint that could over-match — and, being
 * incomplete, it keeps the presence floor rather than clearing egress.
 *
 * Alignment note: the RECORDED side is sparse (bounded memory); the PAYLOAD side
 * is shingled DENSE (step 1, see findTaintInPayload) so any recorded window that
 * is actually present in a payload is found regardless of where the chunk sits —
 * only one side needs step-1 to guarantee detection of a substring overlap.
 */
export function computeFingerprints(content: string): FingerprintResult {
  if (!content) return { fingerprints: [], complete: false };
  const truncatedByContentCap = content.length > MAX_FINGERPRINT_CONTENT;
  const sliced = truncatedByContentCap ? content.slice(0, MAX_FINGERPRINT_CONTENT) : content;
  const norm = normalizeForFingerprint(sliced);
  // Sub-window content yields NO fingerprints, so it can never produce overlap
  // evidence AND can never prove itself absent from a payload → NOT complete
  // (unclearable, keeps the presence floor). Conservative by construction.
  if (norm.length < SHINGLE_WIDTH) return { fingerprints: [], complete: false };
  const { hashes, complete } = shingleHashes(norm, SHINGLE_STEP, MAX_FINGERPRINTS);
  // A content truncated by the raw-byte cap can never be complete, regardless of
  // whether the (truncated) shingling happened to reach its own end.
  return { fingerprints: [...hashes], complete: complete && !truncatedByContentCap };
}

// Dense (step-1) payload fingerprints for overlap matching. Bounded by input
// length (MAX_FINGERPRINT_CONTENT) and a generous hash cap so a single huge
// view can't blow up memory; one view rarely approaches it in practice.
const MAX_PAYLOAD_FINGERPRINTS = MAX_FINGERPRINT_CONTENT;
export function payloadFingerprints(view: string): Set<string> {
  if (!view) return new Set();
  const sliced = view.length > MAX_FINGERPRINT_CONTENT ? view.slice(0, MAX_FINGERPRINT_CONTENT) : view;
  const norm = normalizeForFingerprint(sliced);
  if (norm.length < SHINGLE_WIDTH) return new Set();
  // Payload side only needs the hash set (completeness is a property of RECORDED
  // content, not of an outbound payload being scanned for overlap).
  return shingleHashes(norm, 1, MAX_PAYLOAD_FINGERPRINTS).hashes;
}
