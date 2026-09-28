/**
 * Data Lineage — the payload-overlap verdict (stateless)
 *
 * ONE answer to "do THESE bytes come from recorded content?", over an explicit
 * entry list so every registry can ask it: the sensitive-read taint map
 * (checkEgressTaintWithPayload → the egress gate and the browser/http write
 * adjudicators), the egress worker's mirrored entries, and the external-content
 * registry (external.ts → the memory auto-promotion gate).
 *
 * Verdicts, in the order they are decided:
 *  - "overlap"    — a recorded shingle of some entry is present in the payload
 *                   (raw or any decoded view). Names the entries.
 *  - "unknowable" — no overlap found, but some entry is content-less or only
 *                   HEAD-fingerprinted (incomplete), so its unrecorded tail may
 *                   be in the payload and we could not have detected it.
 *  - "clean"      — every entry is fully fingerprinted and none overlaps; or
 *                   there are no entries at all.
 * The completeness guard is what keeps "clean" honest (see fingerprint.ts,
 * TaintEntry.complete): "no overlap" against a partially covered entry proves
 * only that its covered head is absent.
 */

import { decodedPayloadViews } from "../security/secrets/index.js";
import { type TaintEntry, type TaintSource, payloadFingerprints } from "./fingerprint.js";

export interface OverlapEvidence { source: TaintSource; target: string }

export type PayloadVerdict =
  | { verdict: "overlap"; evidence: OverlapEvidence[] }
  | { verdict: "unknowable"; evidence: [] }
  | { verdict: "clean"; evidence: [] };

/**
 * Which recorded entries have CONTENT present in `payload`. Fingerprints the
 * payload — its raw form AND the secret-scanner's decoded/normalized views (so a
 * base64/hex/percent-encoded or homoglyph copy of the recorded bytes still
 * matches) — and intersects against each entry's recorded shingle hashes. An
 * overlap counts only on a real shingle-hash match, so unrelated text never
 * false-matches (near-zero FP). Entries recorded without content (no
 * fingerprints) can't produce evidence here and are skipped — they still gate
 * via the presence floor / the "unknowable" verdict.
 *
 * Returns the matching {source, target} pairs (deduped); [] when no recorded
 * bytes are found in the payload.
 */
export function findTaintInEntries(taints: readonly TaintEntry[], payload: string): OverlapEvidence[] {
  if (taints.length === 0 || !payload) return [];

  // Hash the payload across every evasion view, REUSING the scanner's decoders
  // (no duplicate decode/normalize logic), then shingle each view the same way
  // recorded content was shingled so the hashes are comparable.
  const payloadHashes = new Set<string>();
  for (const view of decodedPayloadViews(payload)) {
    for (const h of payloadFingerprints(view)) payloadHashes.add(h);
  }
  if (payloadHashes.size === 0) return [];

  const seen = new Set<string>();
  const out: OverlapEvidence[] = [];
  for (const t of taints) {
    if (t.fingerprints.length === 0) continue;
    if (!t.fingerprints.some(fp => payloadHashes.has(fp))) continue;
    const key = `${t.source}:${t.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source: t.source, target: t.target });
  }
  return out;
}

/** The completeness-guarded verdict over an explicit entry list. */
export function adjudicatePayload(taints: readonly TaintEntry[], payload: string): PayloadVerdict {
  if (taints.length === 0) return { verdict: "clean", evidence: [] };
  const evidence = findTaintInEntries(taints, payload);
  if (evidence.length > 0) return { verdict: "overlap", evidence };
  const everyEntryProvable = taints.every(t => t.fingerprints.length > 0 && t.complete);
  return everyEntryProvable ? { verdict: "clean", evidence: [] } : { verdict: "unknowable", evidence: [] };
}
