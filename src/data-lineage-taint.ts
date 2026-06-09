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

import { decodedPayloadViews } from "./security/secret-scanner.js";
import { getLaxDir } from "./lax-data-dir.js";
import { CryptoAuditTrail, getSharedAuditTrail } from "./threat/audit-trail.js";
import {
  type TaintSource,
  type TaintEntry,
  computeFingerprints,
  payloadFingerprints,
} from "./data-lineage-fingerprint.js";

export type { TaintSource, TaintEntry } from "./data-lineage-fingerprint.js";

// Per-session taint state
const sessionTaint = new Map<string, TaintEntry[]>();

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
  sessionTaint.get(sessionId)!.push({
    source,
    target,
    timestamp: Date.now(),
    runId: sessionId,
    fingerprints: content ? computeFingerprints(content) : [],
  });
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
  const taints = sessionTaint.get(sessionId);
  if (!taints || taints.length === 0 || !payload) return [];

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
 * Payload-aware egress check: the presence-based floor (checkEgressTaint) PLUS
 * content-overlap evidence when the outbound payload is in hand. The BLOCK
 * decision is identical to checkEgressTaint (sticky/presence-based — unchanged);
 * `evidence` only SHARPENS the reason by naming which tainted sources actually
 * have bytes in this payload. Additive: the gate can keep calling
 * checkEgressTaint, or call this when it has the payload text.
 */
export function checkEgressTaintWithPayload(
  sessionId: string,
  payload: string,
): { blocked: boolean; reason?: string; evidence: Array<{ source: TaintSource; target: string }> } {
  const base = checkEgressTaint(sessionId);
  if (!base.blocked) return { ...base, evidence: [] };
  const evidence = findTaintInPayload(sessionId, payload);
  if (evidence.length === 0) return { ...base, evidence };
  const named = [...new Set(evidence.map(e => `${e.source}:${e.target.slice(0, 40)}`))];
  return {
    blocked: true,
    reason: `${base.reason} Outbound payload contains bytes from tainted source(s): ${named.join(", ")}.`,
    evidence,
  };
}

/** Clear taint for a session (e.g., on new chat) */
export function clearSessionTaint(sessionId: string): void {
  sessionTaint.delete(sessionId);
}

// ── Declassification (deliberate, audited untaint) ───────────────────────────
//
// clearSessionTaint above is the SILENT new-chat reset — no authorization, no
// audit, because starting a fresh chat is not a security decision. Declassify is
// its DELIBERATE, ATTRIBUTED cousin: a human (or operator action) explicitly
// releases taint so a previously-blocked egress can proceed, and every such
// release is written to the tamper-evident audit chain. This is the escape hatch
// for the "taints forever" floor — explicit and on-the-record, NEVER automatic.
//
// The block decision in checkEgressTaint is unchanged: it only stops blocking
// once the entries are actually cleared HERE, by an explicit declassify call.

export interface DeclassifyOptions {
  /** Human-readable justification for releasing the taint (required, recorded). */
  reason: string;
  /** Who authorized the release (user id / operator / "user-approval"). Recorded. */
  authorizedBy: string;
}

export interface DeclassifyResult {
  /** Number of taint entries removed. */
  cleared: number;
  /** Distinct "source:target" labels that were cleared (NAMES only — never the
   *  fingerprinted content). Empty when nothing matched. */
  sources: Array<{ source: TaintSource; target: string }>;
}

// Lazily-constructed audit trail for declassification events. Points at the
// canonical LAX data dir (getLaxDir()) by default — the SAME chain the security
// route reads/verifies (ctx.dataDir === getLaxDir()) — so a declassify lands in
// the operator's audit log. Overridable for tests via _setDeclassifyAuditTrail.
let declassifyAuditTrail: CryptoAuditTrail | null = null;
function getDeclassifyAuditTrail(): CryptoAuditTrail {
  // Shared single-writer instance (finding H10): all writers for the canonical
  // daily file get the SAME CryptoAuditTrail so interleaved record() calls stay
  // on one serialized chain head. An explicitly-injected test trail still wins
  // (it sets declassifyAuditTrail non-null before this getter runs).
  if (!declassifyAuditTrail) declassifyAuditTrail = getSharedAuditTrail(getLaxDir());
  return declassifyAuditTrail;
}

/** Test hook — inject an audit trail rooted at a temp dir so the declassification
 *  event can be read back and verified without touching the real ~/.lax chain.
 *  Pass null to reset to the default (lazy getLaxDir()) trail. */
export function _setDeclassifyAuditTrail(trail: CryptoAuditTrail | null): void {
  declassifyAuditTrail = trail;
}

// Distinct {source,target} labels for a set of entries — NAMES only, no
// fingerprints. Used both to return what was cleared and to build the audit
// reason, so neither can ever leak recorded content.
function distinctSources(entries: TaintEntry[]): Array<{ source: TaintSource; target: string }> {
  const seen = new Set<string>();
  const out: Array<{ source: TaintSource; target: string }> = [];
  for (const t of entries) {
    const key = `${t.source}:${t.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source: t.source, target: t.target });
  }
  return out;
}

// Append the tamper-evident declassification record. Captures sessionId, the
// cleared source/target NAMES, reason, authorizedBy and a timestamp (the audit
// trail stamps the timestamp). decision:"warn" — declassification deliberately
// RELAXES the egress floor, so it surfaces in review as a loosening, not a clean
// allow. NEVER includes fingerprints/plaintext.
function recordDeclassifyAudit(
  sessionId: string,
  cleared: Array<{ source: TaintSource; target: string }>,
  opts: DeclassifyOptions,
): void {
  const names = cleared.map(c => `${c.source}:${c.target.slice(0, 40)}`);
  getDeclassifyAuditTrail().record({
    sessionId,
    event: "taint_declassified",
    decision: "warn",
    reason: `Taint declassified (authorizedBy=${opts.authorizedBy}): ${opts.reason}. ` +
      `Cleared source(s): ${names.length ? names.join(", ") : "(none)"}.`,
    role: opts.authorizedBy,
    controlsApplied: ["DataLineage"],
  });
}

/**
 * Deliberately clear ALL of a session's taint, on the record.
 *
 * Removes every taint entry for the session AND appends a declassification event
 * to the audit chain (sessionId, cleared source/target names, reason,
 * authorizedBy, timestamp — never fingerprints). After this, checkEgressTaint
 * stops blocking the session because the entries are gone. Always audits, even
 * when the session was already clean (the deliberate release is itself the
 * record). Distinct from clearSessionTaint, which is the silent new-chat reset.
 */
export function declassifySession(sessionId: string, opts: DeclassifyOptions): DeclassifyResult {
  const entries = sessionTaint.get(sessionId) ?? [];
  const sources = distinctSources(entries);
  sessionTaint.delete(sessionId);
  recordDeclassifyAudit(sessionId, sources, opts);
  return { cleared: entries.length, sources };
}

/**
 * Deliberately clear ONLY the entries from a single TaintSource (finer-grained
 * untaint), on the record. The case: the user approves releasing e.g. web-derived
 * taint but NOT secret-derived — so a secret read still blocks egress while the
 * web taint is lifted. Entries from other sources are untouched; the session
 * stays tainted (and blocked) if any remain. Audits the same way as
 * declassifySession.
 */
export function declassifyTaintSource(
  sessionId: string,
  source: TaintSource,
  opts: DeclassifyOptions,
): DeclassifyResult {
  const entries = sessionTaint.get(sessionId);
  if (!entries || entries.length === 0) {
    recordDeclassifyAudit(sessionId, [], opts);
    return { cleared: 0, sources: [] };
  }
  const removed = entries.filter(t => t.source === source);
  const kept = entries.filter(t => t.source !== source);
  if (kept.length === 0) sessionTaint.delete(sessionId);
  else sessionTaint.set(sessionId, kept);
  const sources = distinctSources(removed);
  recordDeclassifyAudit(sessionId, sources, opts);
  return { cleared: removed.length, sources };
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
    // Preserve the child's fingerprints so the parent's evidence path can still
    // attribute payload bytes to the original source. Re-stamp timestamp to the
    // propagation moment (audit only); source/target/fingerprints carried as-is.
    target.push({ source: t.source, target: t.target, timestamp: Date.now(), runId: toSessionId, fingerprints: t.fingerprints });
    count++;
  }
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
