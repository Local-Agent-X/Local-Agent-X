/**
 * Data Lineage — declassification (deliberate, audited untaint)
 *
 * clearSessionTaint (taint.ts) is the SILENT new-chat reset — no authorization,
 * no audit, because starting a fresh chat is not a security decision.
 * Declassify is its DELIBERATE, ATTRIBUTED cousin: a human (or operator action)
 * explicitly releases taint so a previously-blocked egress can proceed, and
 * every such release is written to the tamper-evident audit chain. This is the
 * escape hatch for the "taints forever" floor — explicit and on-the-record,
 * NEVER automatic.
 *
 * The block decision in checkEgressTaint is unchanged: it only stops blocking
 * once the entries are actually cleared here, by an explicit declassify call.
 * Registry mutation stays in taint.ts (_removeTaintEntries) so the session
 * taint map remains module-private.
 */

import { getLaxDir } from "../lax-data-dir.js";
import { CryptoAuditTrail, getSharedAuditTrail } from "../threat/audit-trail.js";
import type { TaintSource, TaintEntry } from "./fingerprint.js";
import { _removeTaintEntries } from "./taint.js";

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
  const entries = _removeTaintEntries(sessionId);
  const sources = distinctSources(entries);
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
  const removed = _removeTaintEntries(sessionId, source);
  const sources = distinctSources(removed);
  recordDeclassifyAudit(sessionId, sources, opts);
  return { cleared: removed.length, sources };
}
