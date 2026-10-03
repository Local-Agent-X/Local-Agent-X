// Private content the agent has read: email bodies and the user's personal
// documents. Not secrets (those are the sensitive-read taint axis, taint.ts)
// and not untrusted input (external.ts): content that belongs to the user and
// should not leave for a destination the user never chose. A send that carries
// it to such a destination is not refused; the user is asked
// (tool-execution/private-content-gate.ts), and a yes is remembered here for
// that one source and destination. Like the other axes, only fingerprints are
// kept, never the text.
//
// Per session, process lifetime, like external ingestion. A session that reads
// past the hash budget drops its oldest entries first, so the newest reads are
// always covered.

import { createHash } from "node:crypto";
import { computeFingerprints, MAX_FINGERPRINT_CONTENT, type TaintEntry } from "./fingerprint.js";
import { findTaintInEntries } from "./payload-overlap.js";

const PRIVATE_HASH_BUDGET = 200_000;
const EMAIL_ADDRESS = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;

/** Every email address written in `text`, lowercased: the bare address out of
 *  `Name <addr>`, `mailto:addr` and plain forms alike. */
export function addressesIn(text: string): string[] {
  return [...new Set((text.match(EMAIL_ADDRESS) ?? []).map((a) => a.toLowerCase()))];
}

interface PrivateEntry extends TaintEntry {
  /** What the card calls it. */
  label: string;
  /** Which source a remembered yes is for. */
  key: string;
  /** Who already holds this content: the addresses on the one email it came
   *  from. Replying to them is not sharing it with anyone new. */
  correspondents: string[];
}

interface SessionPrivate { entries: PrivateEntry[]; seen: Set<string>; hashes: number; approved: Set<string> }

const bySession = new Map<string, SessionPrivate>();

function stateOf(sessionId: string): SessionPrivate {
  let state = bySession.get(sessionId);
  if (!state) {
    state = { entries: [], seen: new Set(), hashes: 0, approved: new Set() };
    bySession.set(sessionId, state);
  }
  return state;
}

export interface PrivateRead {
  /** What was read, as the card names it: "an email you read" or the document's path. */
  label: string;
  /** What one yes covers. A document is one source however often it is read;
   *  a read with no stable name of its own (an email) is its own source, so
   *  approving one email for a recipient does not approve every other one. */
  key?: string;
  correspondents?: readonly string[];
}

export interface PrivateContentMatch {
  label: string;
  key: string;
  correspondents: string[];
}

export function recordPrivateRead(sessionId: string, read: PrivateRead, content: string): void {
  if (!sessionId || !content) return;
  const fp = computeFingerprints(content, MAX_FINGERPRINT_CONTENT);
  if (fp.fingerprints.length === 0) return;
  const digest = createHash("sha256").update(content).digest("hex");
  const state = stateOf(sessionId);
  if (state.seen.has(digest)) return;
  state.seen.add(digest);
  state.entries.push({
    source: "user_data",
    // The overlap check reports one hit per target, so each read keeps its own:
    // two emails sharing a label must not answer for each other's recipients.
    target: digest,
    timestamp: Date.now(),
    runId: sessionId,
    fingerprints: fp.fingerprints,
    complete: fp.complete,
    label: read.label,
    key: read.key ?? digest,
    correspondents: (read.correspondents ?? []).map((c) => c.toLowerCase()),
  });
  state.hashes += fp.fingerprints.length;
  while (state.hashes > PRIVATE_HASH_BUDGET && state.entries.length > 1) {
    const dropped = state.entries.shift()!;
    state.hashes -= dropped.fingerprints.length;
  }
}

/** Has this session read anything private? Lets a send skip working out its
 *  payload (a paste reads the OS clipboard) when nothing could match. */
export function hasPrivateReads(sessionId: string): boolean {
  return (bySession.get(sessionId)?.entries.length ?? 0) > 0;
}

/** The private reads whose bytes appear in `payload` (any decoded view), one per source. */
export function findPrivateContent(sessionId: string, payload: string): PrivateContentMatch[] {
  const state = bySession.get(sessionId);
  if (!state || !payload) return [];
  const hits = new Set(findTaintInEntries(state.entries, payload).map((h) => h.target));
  const bySource = new Map<string, PrivateContentMatch>();
  for (const e of state.entries) {
    if (hits.has(e.target) && !bySource.has(e.key)) bySource.set(e.key, { label: e.label, key: e.key, correspondents: [...e.correspondents] });
  }
  return [...bySource.values()];
}

const shareKey = (sourceKey: string, destinationKey: string): string => `${sourceKey}\n${destinationKey}`;

/** The user approved sending this source to this destination: later sends of
 *  it there, in this session, are not asked about again. */
export function rememberPrivateShare(sessionId: string, sourceKey: string, destinationKey: string): void {
  stateOf(sessionId).approved.add(shareKey(sourceKey, destinationKey));
}

export function privateShareApproved(sessionId: string, sourceKey: string, destinationKey: string): boolean {
  return bySession.get(sessionId)?.approved.has(shareKey(sourceKey, destinationKey)) ?? false;
}

export function clearPrivateContent(sessionId: string): void {
  bySession.delete(sessionId);
}
