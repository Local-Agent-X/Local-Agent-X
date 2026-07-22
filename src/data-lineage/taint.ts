/**
 * Data Lineage — per-session taint registry (stateful)
 *
 * Owns the module-level `sessionTaint` map and every read/query/declassify/
 * propagate operation over it. When data is read from a sensitive source it
 * gets a taint label; if that tainted data flows toward an egress channel the
 * call is blocked — even after transforms (base64, chunked, etc).
 *
 * The key insight: any data that entered the LLM context from a sensitive
 * source is tainted for the rest of the run. The LLM can't "un-see" it.
 */

import { decodedPayloadViews } from "../security/secrets/index.js";
import {
  type TaintSource,
  type TaintEntry,
  computeFingerprints,
  payloadFingerprints,
} from "./fingerprint.js";

export type { TaintSource, TaintEntry } from "./fingerprint.js";

// Per-session taint state
const sessionTaint = new Map<string, TaintEntry[]>();

// ── Change notification (mirror seam) ──────────────────────────────────────
//
// The egress worker thread (browser/egress-worker.ts) cannot see this module's
// map — worker_threads get their own module instances — so it keeps an
// eventually-consistent shadow copy fed by these callbacks. Every mutation
// notifies with the session's POST-mutation entries ([] = session cleared).
type TaintChangeListener = (sessionId: string, entries: readonly TaintEntry[]) => void;
const taintListeners = new Set<TaintChangeListener>();

/**
 * Subscribe to per-session taint changes. Replays every existing session's
 * entries synchronously on subscribe (so a late subscriber — e.g. a restarted
 * egress-worker mirror — starts from the full current state), then fires after
 * every mutation. Returns an unsubscribe.
 */
export function subscribeTaintChanges(cb: TaintChangeListener): () => void {
  taintListeners.add(cb);
  for (const [sessionId, entries] of sessionTaint) cb(sessionId, entries);
  return () => { taintListeners.delete(cb); };
}

function notifyTaintChanged(sessionId: string): void {
  if (taintListeners.size === 0) return;
  const entries = sessionTaint.get(sessionId) ?? [];
  for (const cb of taintListeners) cb(sessionId, entries);
}

/**
 * Record a sensitive data read.
 *
 * `content` is OPTIONAL and additive (3-arg call sites keep working): when
 * provided, content fingerprints are captured so a later egress check can prove
 * which tainted bytes appear in an outbound payload. The source/target
 * provenance recording is unchanged either way. No plaintext is stored.
 */
export function recordSensitiveRead(sessionId: string, source: TaintSource, target: string, content?: string): void {
  if (!sessionTaint.has(sessionId)) sessionTaint.set(sessionId, []);
  const entries = sessionTaint.get(sessionId)!;
  const fp = content ? computeFingerprints(content) : { fingerprints: [], complete: false };
  // Collapse a content-LESS pre-taint twin. The sensitive-read path sets an
  // arg-derived floor SYNCHRONOUSLY before the bytes are read (a content-less
  // entry, so a co-batched egress can't see an empty floor), then re-records the
  // SAME (source,target) WITH content once the read returns. Left as-is, the
  // stale content-less twin would keep the whole session UNCLEARABLE under the
  // completeness guard (a content-less entry never clears), defeating the B+
  // friction fix for the exact common case it targets. So when this record
  // carries real fingerprints, drop any content-less entry for the SAME
  // (source,target): the content-bearing entry fully supersedes it and is at
  // least as strong (complete → clears only a provably-unrelated payload;
  // incomplete → still blocks). A prior content-BEARING read of the same target
  // is NEVER removed — its distinct bytes were seen and must stay provable.
  if (fp.fingerprints.length > 0) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.source === source && e.target === target && e.fingerprints.length === 0) entries.splice(i, 1);
    }
  }
  entries.push({
    source,
    target,
    timestamp: Date.now(),
    runId: sessionId,
    fingerprints: fp.fingerprints,
    complete: fp.complete,
  });
  notifyTaintChanged(sessionId);
}

/** Check if a session has tainted data that should block egress */
export function checkEgressTaint(sessionId: string): { blocked: boolean; reason?: string } {
  const taints = sessionTaint.get(sessionId);
  if (!taints || taints.length === 0) return { blocked: false };

  // STICKY taint: once a session has read sensitive data it stays tainted for
  // the session's life. The recorded timestamp is kept for audit/display only —
  // it does NOT expire the taint (a 5-min decay window silently un-tainted
  // sessions and weakened enforcement; the model can't "un-see" the bytes).
  const sources = [...new Set(taints.map(t => `${t.source}:${t.target.slice(0, 40)}`))];
  return {
    blocked: true,
    reason: `Egress blocked: session contains tainted data from sensitive sources (${sources.join(", ")}). ` +
      `Data lineage tracking prevents exfiltration even through transforms.`,
  };
}

/**
 * Payload-overlap primitive: which tainted sources have CONTENT present in
 * `payload`. Fingerprints the payload — its raw form AND the secret-scanner's
 * decoded/normalized views (so a base64/hex/percent-encoded or homoglyph copy of
 * the tainted bytes still matches) — and intersects against each entry's
 * recorded shingle hashes. An overlap counts only on a real shingle-hash match,
 * so unrelated text never false-matches (near-zero FP). Entries recorded without
 * content (no fingerprints) can't produce evidence here and are skipped — they
 * still gate egress via checkEgressTaint's presence floor.
 *
 * Returns the matching {source, target} pairs (deduped); [] when no tainted
 * bytes are found in the payload.
 */
export function findTaintInPayload(sessionId: string, payload: string): Array<{ source: TaintSource; target: string }> {
  return findTaintInEntries(sessionTaint.get(sessionId) ?? [], payload);
}

/**
 * The pure core of findTaintInPayload, over an EXPLICIT entry list instead of
 * the module-level session map. The egress worker thread runs this against its
 * mirrored entries (its module instance's map is always empty); in-process
 * callers keep using findTaintInPayload. ONE matching implementation.
 */
export function findTaintInEntries(taints: readonly TaintEntry[], payload: string): Array<{ source: TaintSource; target: string }> {
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
  const out: Array<{ source: TaintSource; target: string }> = [];
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

/**
 * Payload-aware egress check — COMPLETENESS-GUARDED Option B+.
 *
 * The presence floor (checkEgressTaint) still governs, but when the outbound
 * payload is in hand this REFINES it: an egress may proceed ONLY when EVERY
 * active taint entry is provably clearable — it carries fingerprints AND those
 * fingerprints cover its ENTIRE recorded content (`complete`) — AND none of them
 * overlap the payload. This narrows the friction of blocking ALL session-wide
 * egress after any sensitive read (read a short config → send a provably
 * unrelated note) WITHOUT opening an exfil hole:
 *
 *  - Direct overlap (payload carries tainted bytes, raw or any decoded view) →
 *    always BLOCK and name the source.
 *  - Any entry that is content-LESS (no fingerprints) or only HEAD-fingerprinted
 *    (incomplete: content too large to fully cover before the bounded cap) is
 *    UNCLEARABLE → BLOCK regardless of payload. "No overlap" against an
 *    incomplete entry proves only that its fingerprinted HEAD is absent, NOT its
 *    unfingerprinted TAIL, so a >cap secret (SSH/PEM key, multi-key .env, aws
 *    credentials, kubeconfig) can never egress its tail bytes by evading the
 *    head window. Security-conservative: cannot PROVE clean of the FULL content
 *    → BLOCK.
 *  - Only when EVERY entry is (fingerprinted AND complete) AND none overlap →
 *    ALLOW (blocked:false).
 *
 * This is NOT time/turn auto-untaint — the block only relaxes for a payload we
 * can prove free of every entry's complete content; declassifySession is
 * unchanged.
 */
export function checkEgressTaintWithPayload(
  sessionId: string,
  payload: string,
): { blocked: boolean; reason?: string; evidence: Array<{ source: TaintSource; target: string }> } {
  const base = checkEgressTaint(sessionId);
  // Clean session: nothing tainted, nothing to prove.
  if (!base.blocked) return { ...base, evidence: [] };

  // Direct content-overlap evidence: tainted bytes actually present in the
  // payload (raw OR any decoded/normalized evasion view). Always blocks.
  const evidence = findTaintInPayload(sessionId, payload);
  if (evidence.length > 0) {
    const named = [...new Set(evidence.map(e => `${e.source}:${e.target.slice(0, 40)}`))];
    return {
      blocked: true,
      reason: `${base.reason} Outbound payload contains bytes from tainted source(s): ${named.join(", ")}.`,
      evidence,
    };
  }

  // No overlap. COMPLETENESS GUARD: clear the egress ONLY if EVERY active entry
  // is fully fingerprinted (proving the payload is free of its WHOLE content).
  // Any content-less or incompletely-fingerprinted entry keeps the presence
  // floor — its tail could be in this payload and we couldn't have detected it.
  const taints = sessionTaint.get(sessionId)!; // non-empty: base.blocked is true
  const everyEntryClearable = taints.every(t => t.fingerprints.length > 0 && t.complete);
  if (everyEntryClearable) return { blocked: false, evidence: [] };
  return { ...base, evidence: [] };
}

/**
 * Set a session's taint to a set of externally-computed entries — the host's
 * ingest seam for taint FORWARDED from a container process over the browser
 * relay (container-bridge-lineage.ts).
 *
 * WHY: when a container drives the in-app browser, its agent loop runs in a
 * separate process, so its sensitive-read taint accrues in THAT process's map —
 * the host's page-egress scan (page-egress-taint.ts) would see an empty registry
 * for the session and wave an exfil request through. The container forwards its
 * post-mutation entries (full-state deltas, mirroring the subscribe seam) and the
 * host lands them HERE, keyed by the (relay-authenticated, owner-confined)
 * session, so the SAME canonical scan now sees them. notifyTaintChanged fires so
 * the off-loop egress worker mirror picks the forwarded taint up too.
 *
 * REPLACE (not merge) is correct and matches the mirror contract: execution for
 * a container-owned session is claimed by the container, so the host never
 * independently taints that session — the container is the sole writer and sends
 * full state each change. Entries are copied defensively (fresh objects, own
 * fingerprint arrays) so the caller's wire array is not retained. Empty → clear.
 */
export function setForwardedSessionTaint(sessionId: string, entries: readonly TaintEntry[]): void {
  if (entries.length === 0) {
    if (sessionTaint.delete(sessionId)) notifyTaintChanged(sessionId);
    return;
  }
  sessionTaint.set(sessionId, entries.map(e => ({
    source: e.source,
    target: e.target,
    timestamp: e.timestamp,
    runId: e.runId,
    fingerprints: [...e.fingerprints],
    complete: e.complete,
  })));
  notifyTaintChanged(sessionId);
}

/** Clear taint for a session (e.g., on new chat) */
export function clearSessionTaint(sessionId: string): void {
  if (sessionTaint.delete(sessionId)) notifyTaintChanged(sessionId);
}

/**
 * Withdraw provisional (content-less) floor entries for exact (source, target)
 * pairs — the delivery-point invariant's counterpart to the pre-execute floor.
 *
 * Taint exists because sensitive bytes entered the model context. The execute
 * phase sets an arg-derived floor BEFORE a sensitive read runs (so a co-batched
 * egress can't observe an empty floor), then decides delivery: when the whole
 * result is replaced by the redaction stub, the bytes provably never reached
 * the model, and the floor for THAT call is withdrawn here. Only content-LESS
 * entries match — a content-bearing entry records bytes that WERE delivered
 * and is never removed by this path. This is not a declassify: no seen bytes
 * are being released, so no audit event is owed.
 */
export function retractProvisionalTaint(sessionId: string, pairs: Array<{ source: TaintSource; target: string }>): number {
  const entries = sessionTaint.get(sessionId);
  if (!entries || entries.length === 0 || pairs.length === 0) return 0;
  const keys = new Set(pairs.map(p => `${p.source}:${p.target}`));
  let removed = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.fingerprints.length === 0 && keys.has(`${e.source}:${e.target}`)) {
      entries.splice(i, 1);
      removed++;
    }
  }
  if (entries.length === 0) sessionTaint.delete(sessionId);
  if (removed > 0) notifyTaintChanged(sessionId);
  return removed;
}

/**
 * INTERNAL — declassify.ts only. Remove and return a session's taint entries:
 * all of them, or only those from one source. The audited declassify API lives
 * in declassify.ts; the map mutation stays here so sessionTaint remains
 * module-private.
 */
export function _removeTaintEntries(sessionId: string, source?: TaintSource): TaintEntry[] {
  const entries = sessionTaint.get(sessionId);
  if (!entries || entries.length === 0) return [];
  if (source === undefined) {
    sessionTaint.delete(sessionId);
    notifyTaintChanged(sessionId);
    return entries;
  }
  const removed = entries.filter(t => t.source === source);
  const kept = entries.filter(t => t.source !== source);
  if (kept.length === 0) sessionTaint.delete(sessionId);
  else sessionTaint.set(sessionId, kept);
  if (removed.length > 0) notifyTaintChanged(sessionId);
  return removed;
}

// LAX → AriKernel taint-source mapping. The kernel's behavioral deny rules
// (deny-tainted-shell / deny-tainted-http-write) key on the kernel's untrusted-
// content sources ["web","rag","email"]; the kernel also recognizes
// "user-provided" (NOT in the deny set — the user's own input is trusted).
//
// LAX's taint model is COARSER than the kernel's: "the session touched sensitive
// bytes" rather than a fine-grained provenance lattice. So every LAX source that
// represents untrusted-or-sensitive content the model has now seen maps onto a
// kernel source the deny rules recognize, so a sensitive read here lights up the
// kernel's tainted-shell / tainted-egress enforcement. `user_data` is the one
// trusted source and maps to "user-provided" (intentionally outside the deny set).
const KERNEL_TAINT_SOURCE: Record<TaintSource, string> = {
  web: "web",
  memory: "rag",
  sensitive_file: "rag",
  secret: "rag",
  user_data: "user-provided",
};

/**
 * Read the current session's taint as AriKernel taint-source strings, for
 * feeding into ariEvaluate's 4th `taintLabels` arg. STICKY: every recorded
 * sensitive read counts regardless of elapsed time (mirrors checkEgressTaint —
 * a sensitive read keeps the session tainted for its life). Returns deduped
 * kernel sources; [] when the session is clean.
 *
 * This is the bridge between chunk 3's recordSensitiveRead and the kernel's
 * behavioral taint rules: the kernel only blocks tainted shell/egress if it
 * actually receives non-empty taint, and this is where LAX hands it over.
 */
export function getKernelTaintSources(sessionId: string): string[] {
  const taints = sessionTaint.get(sessionId);
  if (!taints || taints.length === 0) return [];
  const sources = new Set<string>();
  for (const t of taints) {
    sources.add(KERNEL_TAINT_SOURCE[t.source]);
  }
  return [...sources];
}

/**
 * Propagate taint from one session into another (parent ← child).
 *
 * When a sub-agent (child session) has read sensitive data, its taint must
 * follow the result back to the parent so the parent's egress / kernel gates
 * see it. Copies ALL of the child's taint entries into the target session
 * (taint is sticky — no active-window filter), preserving the original
 * source/target. recordSensitiveRead re-stamps the timestamp to the
 * propagation moment for audit only. No-op when the child is clean.
 *
 * Returns the number of taint entries propagated (for logging / tests).
 */
export function propagateTaint(fromSessionId: string, toSessionId: string): number {
  if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return 0;
  const fromTaints = sessionTaint.get(fromSessionId);
  if (!fromTaints || fromTaints.length === 0) return 0;
  if (!sessionTaint.has(toSessionId)) sessionTaint.set(toSessionId, []);
  const target = sessionTaint.get(toSessionId)!;
  let count = 0;
  for (const t of fromTaints) {
    // Preserve the child's fingerprints AND completeness so the parent's egress
    // check makes the SAME clearable/unclearable decision (an incomplete child
    // entry stays unclearable in the parent — the hole doesn't reopen across the
    // propagation seam). Re-stamp timestamp to the propagation moment (audit
    // only); source/target/fingerprints/complete carried as-is.
    target.push({ source: t.source, target: t.target, timestamp: Date.now(), runId: toSessionId, fingerprints: t.fingerprints, complete: t.complete });
    count++;
  }
  if (count > 0) notifyTaintChanged(toSessionId);
  return count;
}

/** Get session taint summary */
export function getTaintSummary(sessionId: string): { count: number; sources: string[] } {
  const taints = sessionTaint.get(sessionId) || [];
  return {
    count: taints.length,
    sources: [...new Set(taints.map(t => t.source))],
  };
}
