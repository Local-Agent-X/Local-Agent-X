/**
 * Data Lineage Tracker
 *
 * Tracks the flow of data through tool calls within a session.
 * When data is read from a sensitive source, it gets a taint label.
 * If that tainted data flows into an egress channel (http, browser),
 * the call is blocked — even if the data was transformed (base64, chunked, etc).
 *
 * Unlike regex-based detection, this tracks by CALL SEQUENCE:
 *   read(sensitive_file) → bash(any_transform) → http_request = BLOCKED
 *
 * The key insight: any data that entered the LLM context from a sensitive
 * source is tainted for the rest of the run. The LLM can't "un-see" it.
 */

import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { scanForSecrets, decodedPayloadViews } from "./security/secret-scanner.js";
import { getLaxDir } from "./lax-data-dir.js";
import { CryptoAuditTrail, getSharedAuditTrail } from "./threat/audit-trail.js";

export type TaintSource = "sensitive_file" | "secret" | "memory" | "web" | "user_data";

interface TaintEntry {
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
function computeFingerprints(content: string): string[] {
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
function payloadFingerprints(view: string): Set<string> {
  if (!view) return new Set();
  const sliced = view.length > MAX_FINGERPRINT_CONTENT ? view.slice(0, MAX_FINGERPRINT_CONTENT) : view;
  const norm = normalizeForFingerprint(sliced);
  if (norm.length < SHINGLE_WIDTH) return new Set();
  return shingleHashes(norm, 1, MAX_PAYLOAD_FINGERPRINTS);
}

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

// Basenames that are credential files regardless of where they live on disk.
// Match is case-insensitive but exact — `secrets.json` matches, `mysecrets.json`
// and `secrets.py` do not.
const SENSITIVE_BASENAMES: ReadonlySet<string> = new Set([
  // Shell / package auth dotfiles.
  ".env", ".envrc", ".npmrc", ".pypirc", ".netrc",
  // SSH private keys (canonical algorithm names).
  "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa",
  // Generic credential / secrets files.
  "auth.json",
  "secrets.json", "secrets.yaml", "secrets.yml", "secrets.toml",
  "credentials.json", "credentials.db",
  // Windows DPAPI-protected master keys (Chromium, etc.).
  "master.dpapi", "master.key",
]);

// Suffix matches for key material containers. Endpoint-anchored, so a
// `notes.key.md` file doesn't trip on `.key`.
const SENSITIVE_EXTENSIONS: ReadonlyArray<string> = [
  ".pem", ".key", ".p12", ".pfx", ".keystore", ".keychain-db",
];

// (parent-directory, basename) pairs. The file is sensitive only when its
// immediate parent directory has the named identity — so `~/.aws/credentials`
// trips, but `~/notes/credentials` does not, and a stray `config` file is
// only flagged inside a known config-dir (.ssh, .aws, .kube).
const DIR_SCOPED_FILES: ReadonlyArray<readonly [string, string]> = [
  [".aws", "credentials"],
  [".aws", "config"],
  [".ssh", "config"],
  [".docker", "config.json"],
  [".kube", "config"],
  // gcloud + gh credential stores live under ~/.config/<tool>/...
  ["gcloud", "credentials.db"],
  ["gcloud", "access_tokens.db"],
  ["gcloud", "legacy_credentials"],
  ["gh", "hosts.yml"],
];

// Directories whose entire contents are credential material. Any file at any
// depth inside one of these is flagged.
const SENSITIVE_DIR_NAMES: ReadonlySet<string> = new Set([".gnupg"]);

function pathSegments(p: string): string[] {
  return p.split(/[\\/]/).filter(Boolean);
}

/**
 * Check if a file path is sensitive (triggers taint on read).
 *
 * Matches by file shape, NOT by substring. The prior implementation used
 * unanchored patterns like `/password/i` and `/credentials/i` that fired on
 * `password_audit.log`, `tokenizer.py`, and any README mentioning secrets —
 * generating enough false positives that users stopped trusting the gate.
 * This version anchors on basename, extension, or known credential-directory
 * locations only.
 */
export function isSensitivePath(filePath: string): boolean {
  if (!filePath) return false;
  const segs = pathSegments(filePath);
  if (segs.length === 0) return false;
  const segsLower = segs.map(s => s.toLowerCase());
  const base = segsLower[segsLower.length - 1];

  if (SENSITIVE_BASENAMES.has(base)) return true;
  // `.env.local`, `.env.production`, etc. Open-ended, so not in the basename set.
  if (base.startsWith(".env.")) return true;
  for (const ext of SENSITIVE_EXTENSIONS) {
    if (base.endsWith(ext)) return true;
  }

  if (segsLower.length >= 2) {
    const parent = segsLower[segsLower.length - 2];
    for (const [dir, name] of DIR_SCOPED_FILES) {
      if (parent === dir && base === name) return true;
    }
  }

  for (const seg of segsLower) {
    if (SENSITIVE_DIR_NAMES.has(seg)) return true;
  }

  return false;
}

// --- Egress-attachment sink: stricter than the read-taint predicate above ---
//
// `isSensitivePath` is the READ-TAINT predicate: reading a matching file taints
// the session. It is deliberately NARROW (anchored basenames / extensions /
// known cred-dir pairs) because over-flagging there causes taint storms —
// the app reads its own `.lax` data dir and routine `.enc`/key files constantly,
// and tainting on each would block every subsequent egress. The existing spec
// table even encodes that `.ssh/known_hosts`, `.ssh/*.pub`, etc. are NOT tainted.
//
// The email-attachment sink has the opposite risk profile: a file is read AND
// shipped off-box, so a miss is an exfiltration. Here we err toward blocking.
// This predicate is a SUPERSET of `isSensitivePath` plus whole-directory rules
// for the app's own secrets dir and common credential stores. It is used ONLY by
// the attachment guard (http-egress-guard.ts), never for read-taint.

// Directories whose entire contents are off-limits to attach. Any file at any
// depth inside one of these is sensitive for the attachment sink.
// `.lax` (the app's own secrets/vault dir) plus the canonical credential stores.
const ATTACHMENT_SENSITIVE_DIR_NAMES: ReadonlySet<string> = new Set([
  ".gnupg", ".ssh", ".aws", ".lax",
]);

// Basenames/extensions that signal an encrypted vault or key container and must
// never leave as an attachment. Supplements SENSITIVE_EXTENSIONS (.pem/.key/...).
const ATTACHMENT_SENSITIVE_EXTENSIONS: ReadonlyArray<string> = [".enc"];

// Inside `.ssh`, these are low-risk and may be attached (host fingerprints,
// public keys). Everything else under `.ssh` is a potential private key with an
// arbitrary filename, so it is blocked. NB: `.ssh/config` is intentionally NOT
// listed — `isSensitivePath` already flags it (DIR_SCOPED_FILES), and it can
// reference IdentityFile/ProxyCommand secrets, so blocking it is correct.
const SSH_BENIGN_BASENAMES: ReadonlySet<string> = new Set([
  "known_hosts", "known_hosts.old", "authorized_keys",
]);

/**
 * Stricter sensitive-path check for the egress-attachment sink (email_send
 * attachments, etc.). Returns true if attaching this file would ship credential
 * or secret material off-box.
 *
 * Superset of {@link isSensitivePath}, plus:
 *  - any file under `.ssh` / `.aws` / `.lax` / `.gnupg` (whole-dir), EXCEPT a
 *    short allowlist of benign `.ssh` files (`known_hosts`, `config`, `*.pub`);
 *  - the resolved LAX data dir basename, so a relocated `LAX_DATA_DIR` (a dir not
 *    literally named `.lax`) is still covered;
 *  - `.enc` containers (e.g. the `secrets.enc` vault).
 *
 * Segment-based matching, so `~/.lax/secrets.enc`, `/Users/x/.lax/secrets.enc`,
 * and a `LAX_DATA_DIR`-relocated dir all resolve identically — a leading `~`
 * does not need expansion to match a directory-name segment.
 */
export function isSensitiveAttachmentPath(filePath: string): boolean {
  if (!filePath) return false;
  // The narrow read-taint predicate already covers the anchored cases
  // (.env, id_rsa, *.pem, .aws/credentials, .gnupg/*, ...).
  if (isSensitivePath(filePath)) return true;

  const segs = pathSegments(filePath);
  if (segs.length === 0) return false;
  const segsLower = segs.map(s => s.toLowerCase());
  const base = segsLower[segsLower.length - 1];

  // Whole-directory rules. `.ssh` is handled separately (benign-file allowlist).
  for (const seg of segsLower) {
    if (seg === ".ssh") {
      if (base.endsWith(".pub")) return false;
      if (SSH_BENIGN_BASENAMES.has(base)) return false;
      return true;
    }
    if (ATTACHMENT_SENSITIVE_DIR_NAMES.has(seg)) return true;
  }

  // Relocated LAX data dir (LAX_DATA_DIR points at a dir not named `.lax`).
  const laxBase = pathSegments(getLaxDir()).pop()?.toLowerCase();
  if (laxBase && segsLower.includes(laxBase)) return true;

  // Encrypted vault containers (e.g. secrets.enc).
  for (const ext of ATTACHMENT_SENSITIVE_EXTENSIONS) {
    if (base.endsWith(ext)) return true;
  }

  return false;
}

/** Get session taint summary */
export function getTaintSummary(sessionId: string): { count: number; sources: string[] } {
  const taints = sessionTaint.get(sessionId) || [];
  return {
    count: taints.length,
    sources: [...new Set(taints.map(t => t.source))],
  };
}

// Shell metacharacters that separate tokens we care about. We intentionally
// keep this conservative — false positives here mean a legitimate http call
// gets blocked, which is worse than missing an exotic obfuscation.
const SHELL_SPLIT_RE = /[\s|<>;()&]+/;

function looksLikePathToken(token: string): boolean {
  if (!token) return false;
  if (token.startsWith("/")) return true;
  if (token.startsWith("~")) return true;
  if (/^[A-Za-z]:[\\/]/.test(token)) return true;
  // Relative or bare token with a separator — only treat as path if it has
  // a dot or recognisable directory segment so things like `echo foo/bar`
  // (no extension, no leading dot) don't false-positive on the `.ssh`
  // pattern when the substring happens to appear.
  if ((token.includes("/") || token.includes("\\")) && /\./.test(token)) return true;
  return false;
}

function stripQuotes(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return token.slice(1, -1);
    }
  }
  return token;
}

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return homedir() + p.slice(1);
  return p;
}

// Max bytes scanned for secrets. Larger inputs are sliced; missed taint on a
// >256KB response is acceptable (rare) and bounded scan keeps the regex pass
// cheap on huge stdout dumps.
const SECRET_SCAN_CAP = 256 * 1024;

/**
 * Scan text (bash stdout, http response body, web fetch body) for secret-shaped
 * substrings. Returns `kinds` (canonical pattern names) only — NEVER the matched
 * value, so logging the result can't leak the secret. `kinds` is informational
 * (taint-target label / log line); no downstream logic keys on specific strings.
 *
 * A pure adapter over the canonical scanForSecrets (security/secret-scanner.ts):
 * taint, redaction and the http egress guard share ONE catalog
 * (credential-patterns.ts) so they can never drift on "what is a secret". The
 * former supplemental set (Google/OpenAI-scoped keys, JWTs, bare PEM markers)
 * now lives in that catalog.
 *
 * Caller responsibility: if `matched` is true, call recordSensitiveRead with
 * source "secret" to taint the session.
 */
export function detectSecretsInOutput(text: string): { matched: boolean; kinds: string[] } {
  if (!text || typeof text !== "string") return { matched: false, kinds: [] };
  const slice = text.length > SECRET_SCAN_CAP ? text.slice(0, SECRET_SCAN_CAP) : text;
  const kinds = new Set<string>();

  for (const m of scanForSecrets(slice).matches) {
    kinds.add(m.pattern);
  }

  return { matched: kinds.size > 0, kinds: [...kinds] };
}

/**
 * Redact secret-shaped substrings IN PLACE, returning the cleaned text + kinds.
 *
 * Unlike {@link detectSecretsInOutput} (report-only, caller taints the session),
 * this surgically replaces each matched span with `[redacted-secret:<kind>]` so
 * the surrounding content survives. Used for UNTRUSTED INBOUND content
 * (web_fetch / http_request bodies): a secret-shaped span there is coincidental
 * or an injection attempt, not a secret this system owns — so we strip it from
 * the model's view (no echo/exfil) WITHOUT discarding the whole page or tainting
 * egress. Owned-secret reads (local fs / bash / sql) keep the heavier
 * detect→taint→full-redact path.
 */
export function redactSecretSpans(text: string): { text: string; matched: boolean; kinds: string[] } {
  if (!text || typeof text !== "string") return { text: text ?? "", matched: false, kinds: [] };
  // Bounded scan, mirroring detectSecretsInOutput: redact within the cap, pass
  // the tail through unchanged (a missed secret past 256KB is the accepted edge).
  const head = text.length > SECRET_SCAN_CAP ? text.slice(0, SECRET_SCAN_CAP) : text;
  const tail = text.length > SECRET_SCAN_CAP ? text.slice(SECRET_SCAN_CAP) : "";
  const kinds = new Set<string>();

  // Collect every span to redact from the canonical scanner (one catalog).
  // Replace end-to-start so earlier replacements don't invalidate later indices.
  const spans: Array<{ start: number; end: number; kind: string }> = [];
  for (const m of scanForSecrets(head).matches) {
    spans.push({ start: m.startIndex, end: m.endIndex, kind: m.pattern });
  }

  // Drop spans fully contained in an earlier (kept) span so overlapping
  // catalog matches don't double-redact the same bytes.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: typeof spans = [];
  let coveredTo = -1;
  for (const s of spans) {
    if (s.start >= coveredTo) {
      kept.push(s);
      coveredTo = s.end;
    } else if (s.end > coveredTo) {
      // Partial overlap (different pattern extends further): keep, advance cover.
      kept.push(s);
      coveredTo = s.end;
    }
  }

  let out = head;
  for (const s of [...kept].sort((a, b) => b.start - a.start)) {
    kinds.add(s.kind);
    out = out.slice(0, s.start) + `[redacted-secret:${s.kind}]` + out.slice(s.end);
  }
  return { text: out + tail, matched: kinds.size > 0, kinds: [...kinds] };
}

/**
 * Scan a shell command for path-like tokens that match isSensitivePath.
 * Returns matched paths (deduped, original token form post-quote-strip
 * pre-tilde-expansion — callers should re-check with isSensitivePath if
 * they care about the resolved form).
 *
 * Conservative by design: only fires on tokens that clearly look like
 * filesystem paths (leading `/`, `~`, drive letter, or separator+dot).
 */
export function extractSensitivePathsFromCommand(command: string): string[] {
  if (!command) return [];
  const seen = new Set<string>();
  const matches: string[] = [];
  for (const raw of command.split(SHELL_SPLIT_RE)) {
    if (!raw) continue;
    // Strip a trailing `>` or `,` that some shells leave attached; we already
    // split on most metachars but redirects like `2>file` split to `file`.
    const token = stripQuotes(raw);
    if (!looksLikePathToken(token)) continue;
    const expanded = expandTilde(token);
    if (!isSensitivePath(expanded)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    matches.push(token);
  }
  return matches;
}
