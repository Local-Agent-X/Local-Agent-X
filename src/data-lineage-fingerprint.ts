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
// Max fingerprints kept per entry (memory bound: ~32 * 16 bytes hex ≈ 0.5KB).
const MAX_FINGERPRINTS = 32;
// Max content bytes fingerprinted. Beyond this we sample the head only; a missed
// overlap on a multi-hundred-KB read is the accepted edge (mirrors the scanner's
// 256KB cap), and it keeps hashing cheap on huge stdout dumps.
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

// Shingle `norm` into window hashes at the given step, capped at `max` hashes.
function shingleHashes(norm: string, step: number, max: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE_WIDTH <= norm.length && out.size < max; i += step) {
    out.add(shingleHash(norm.slice(i, i + SHINGLE_WIDTH)));
  }
  return out;
}

/**
 * Compute content fingerprints for sensitive content: hashes of normalized
 * char-window shingles at SHINGLE_STEP (sparse — keeps the stored set bounded by
 * MAX_FINGERPRINTS). Returns [] for empty/too-short content (nothing a single
 * window could cover) so a short read just records provenance, not a fingerprint
 * that could over-match.
 *
 * Alignment note: the RECORDED side is sparse (bounded memory); the PAYLOAD side
 * is shingled DENSE (step 1, see findTaintInPayload) so any recorded window that
 * is actually present in a payload is found regardless of where the chunk sits —
 * only one side needs step-1 to guarantee detection of a substring overlap.
 */
export function computeFingerprints(content: string): string[] {
  if (!content) return [];
  const sliced = content.length > MAX_FINGERPRINT_CONTENT ? content.slice(0, MAX_FINGERPRINT_CONTENT) : content;
  const norm = normalizeForFingerprint(sliced);
  if (norm.length < SHINGLE_WIDTH) return [];
  return [...shingleHashes(norm, SHINGLE_STEP, MAX_FINGERPRINTS)];
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
  return shingleHashes(norm, 1, MAX_PAYLOAD_FINGERPRINTS);
}
