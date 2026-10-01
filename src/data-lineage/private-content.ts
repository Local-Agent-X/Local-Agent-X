// Private content the agent has read: email bodies and the user's personal
// documents. Not secrets (those are the sensitive-read taint axis, taint.ts)
// and not untrusted input (external.ts): content that belongs to the user and
// should not leave for a destination the user never chose. A send that carries
// it to such a destination is not refused; the user is asked
// (tool-execution/private-content-gate.ts). Like the other axes, only
// fingerprints are kept, never the text.
//
// Per session, process lifetime, like external ingestion. A session that reads
// past the hash budget drops its oldest entries first, so the newest reads are
// always covered.

import { createHash } from "node:crypto";
import { computeFingerprints, MAX_FINGERPRINT_CONTENT, type TaintEntry } from "./fingerprint.js";
import { findTaintInEntries } from "./payload-overlap.js";

const PRIVATE_HASH_BUDGET = 200_000;

interface PrivateEntry extends TaintEntry {
  /** Who already holds this content: the addresses on the one email it came
   *  from. Replying to them is not sharing it with anyone new. */
  correspondents: string[];
}

interface SessionPrivate { entries: PrivateEntry[]; seen: Set<string>; hashes: number }

const bySession = new Map<string, SessionPrivate>();

export interface PrivateContentMatch {
  /** What was read: "email" or the document's path. */
  target: string;
  correspondents: string[];
}

export function recordPrivateRead(sessionId: string, target: string, content: string, correspondents: readonly string[] = []): void {
  if (!sessionId || !content) return;
  const fp = computeFingerprints(content, MAX_FINGERPRINT_CONTENT);
  if (fp.fingerprints.length === 0) return;
  const digest = createHash("sha256").update(content).digest("hex");
  const state = bySession.get(sessionId) ?? { entries: [], seen: new Set<string>(), hashes: 0 };
  bySession.set(sessionId, state);
  if (state.seen.has(digest)) return;
  state.seen.add(digest);
  state.entries.push({
    source: "user_data",
    target,
    timestamp: Date.now(),
    runId: sessionId,
    fingerprints: fp.fingerprints,
    complete: fp.complete,
    correspondents: correspondents.map((c) => c.toLowerCase()),
  });
  state.hashes += fp.fingerprints.length;
  while (state.hashes > PRIVATE_HASH_BUDGET && state.entries.length > 1) {
    const dropped = state.entries.shift()!;
    state.hashes -= dropped.fingerprints.length;
  }
}

/** The private reads whose bytes appear in `payload` (any decoded view). */
export function findPrivateContent(sessionId: string, payload: string): PrivateContentMatch[] {
  const state = bySession.get(sessionId);
  if (!state || !payload) return [];
  const hits = findTaintInEntries(state.entries, payload);
  if (hits.length === 0) return [];
  const byTarget = new Map(state.entries.map((e) => [e.target, e]));
  return hits.map((h) => ({ target: h.target, correspondents: byTarget.get(h.target)?.correspondents ?? [] }));
}

export function clearPrivateContent(sessionId: string): void {
  bySession.delete(sessionId);
}
