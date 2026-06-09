import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { computeAuditMarkerMac, getAuditHmacKey, hasPersistedAuditKey } from "../app-runtime/audit-signing.js";
import { createLogger } from "../logger.js";
import type { DataLabel } from "./classification.js";
import type { ThreatLevel } from "./scoring.js";

const logger = createLogger("threat.audit-trail");

// ═══════════════════════════════════════════════════════════════════
// CRYPTOGRAPHIC AUDIT TRAIL — Hash-chained tamper-evident log
// ═══════════════════════════════════════════════════════════════════
//
// Each entry is chained by an HMAC-SHA256 keyed digest over ALL of its
// security-relevant fields. The HMAC key is the per-install audit key
// (see audit-signing.ts). This means:
//   - Any change to a decision-bearing field (decision, reason, role,
//     threatScore, dataLabels, …) breaks the chain.
//   - An attacker with only filesystem access cannot recompute a valid
//     chain — a plain SHA-256 forgery will not match.
// Honest limit: an attacker who compromises the live kernel process can
// still read the key from memory, so this is tamper-evidence with
// authenticity, NOT non-repudiation against a process compromise.

const GENESIS_PREV_HASH = "GENESIS";
const GENESIS_ANCHOR_HASH = "ANCHOR-GENESIS";

// External anchor file: a second, independent keyed chain over the running
// chain-head. It exists to close the one gap the linear log can't see on its
// own — TAIL TRUNCATION. Dropping trailing entries leaves a perfectly valid
// shorter chain (the genesis-anchor check only catches re-rooting, not an
// end-cut), so an attacker who can append-then-rewind would erase their tracks
// silently. The anchor records (maxSeq, headHash, count); verify cross-checks
// it, so a truncated log no longer matches its anchor and fails.
//
// Honest limit: the anchor file lives in the same dir at the same privilege —
// a key-holding attacker who rewrites BOTH files consistently still defeats it.
// The real teeth come from the head being EMITTED to the app log (logger) each
// record, so an off-box log shipper holds a copy beyond the attacker's reach.
// This is rewrite-DETECTION groundwork, not rewrite-prevention.
interface AnchorRecord {
  seq: number;        // chain head seq this anchor pins
  count: number;      // total entries at this point (seq + 1)
  chainHash: string;  // the main chain entry hash being anchored
  prevAnchor: string; // previous anchorHash (independent chain)
  anchorHash: string; // HMAC over the fields above
}

interface AuditEntry {
  seq: number;
  timestamp: string;
  sessionId: string;
  event: string;
  toolName?: string;
  decision: "allow" | "block" | "warn";
  reason: string;
  role?: string;                    // RBAC role of the caller (operator/user/readonly)
  controlsApplied?: string[];       // Which security controls evaluated this (SecurityLayer, ToolPolicy, ThreatEngine, etc.)
  threatScore?: number;
  threatLevel?: ThreatLevel;
  dataLabels?: DataLabel[];
  hash: string;        // HMAC-SHA256 of this entry's canonical payload
  prevHash: string;    // Hash of previous entry (chain)
  /**
   * Hash scheme tag. "hmac-v1" marks entries written under the keyed,
   * full-field scheme. Absent on legacy plain-SHA-256 entries (which were
   * written before this upgrade and verify under the legacy path).
   */
  hashScheme?: "hmac-v1";
}

/**
 * Deterministic canonical serialization of the security-relevant fields that
 * must be inside the chain digest. Stable key order is required so that
 * verification reproduces exactly the bytes that were signed. Anything a
 * tamperer could alter to rewrite history belongs in here.
 */
function canonicalPayload(e: AuditEntry): string {
  return JSON.stringify([
    ["seq", e.seq],
    ["timestamp", e.timestamp],
    ["sessionId", e.sessionId],
    ["event", e.event],
    ["toolName", e.toolName ?? null],
    ["decision", e.decision],
    ["reason", e.reason],
    ["role", e.role ?? null],
    ["controlsApplied", e.controlsApplied ?? null],
    ["threatScore", e.threatScore ?? null],
    ["threatLevel", e.threatLevel ?? null],
    ["dataLabels", e.dataLabels ?? null],
    ["prevHash", e.prevHash],
    // Bind the scheme tag INTO the keyed digest so it can't be stripped or
    // swapped to downgrade an entry onto the unkeyed legacy verify path
    // without breaking the HMAC.
    ["hashScheme", e.hashScheme ?? null],
  ]);
}

/** Legacy payload — the original narrow field set, plain SHA-256. */
function legacyPayload(e: AuditEntry): string {
  return JSON.stringify({
    seq: e.seq,
    timestamp: e.timestamp,
    sessionId: e.sessionId,
    event: e.event,
    toolName: e.toolName,
    decision: e.decision,
    reason: e.reason,
    prevHash: e.prevHash,
  });
}

function hmacKeyBuffer(): Buffer {
  const raw = getAuditHmacKey();
  return Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
}

function computeEntryHash(e: AuditEntry): string {
  return createHmac("sha256", hmacKeyBuffer()).update(canonicalPayload(e)).digest("hex");
}

/** Keyed MAC over an anchor's fields — the anchor file's own chain digest. */
function computeAnchorHash(a: Omit<AnchorRecord, "anchorHash">): string {
  const payload = JSON.stringify([a.seq, a.count, a.chainHash, a.prevAnchor]);
  return createHmac("sha256", hmacKeyBuffer()).update(payload).digest("hex");
}

/** `<dir>/<date>.jsonl` → `<dir>/<date>.anchors.jsonl`. */
function anchorPathFor(auditFilePath: string): string {
  return auditFilePath.replace(/\.jsonl$/, ".anchors.jsonl");
}

/** Today's daily-file date stamp (UTC, YYYY-MM-DD) — drives the file name and
 *  the midnight rollover check. */
function currentAuditDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── hmac-v1 era marker ───────────────────────────────────────────────
// Once a single hmac-v1 entry has ever been written, the audit dir is in the
// "hmac-v1 era" and verify() MUST refuse to fall back to the unkeyed legacy
// path for ANY row — otherwise a filesystem-only attacker rewrites the whole
// file as self-consistent plain-SHA-256 (no key needed) and verify passes.
//
// The marker lives next to the audit data and is SEALED under the audit key: it
// stores a keyed MAC over a fixed string, so an attacker without the key can
// neither forge the marker nor delete-then-recreate it convincingly. Deleting
// the marker entirely doesn't help the attacker either — a chain that still
// contains hmac-v1 rows is verified as hmac-v1 regardless (see verify()).
const MARKER_PAYLOAD = "lax-audit-hmac-v1-era";

/** `<auditDir>/.hmac-v1.marker` — one per audit dir, not per day. */
function markerPathFor(auditFilePath: string): string {
  return join(dirname(auditFilePath), ".hmac-v1.marker");
}

/** Write the era marker (idempotent) sealed under the audit key, mode 0o600. */
function writeEraMarker(markerPath: string): void {
  if (existsSync(markerPath)) return;
  const body = JSON.stringify({ era: "hmac-v1", mac: computeAuditMarkerMac(MARKER_PAYLOAD) });
  // Atomic tmp+rename, mirroring writeAtomic() in audit-signing.ts.
  const tmp = `${markerPath}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, markerPath);
}

/**
 * Is the hmac-v1 era marker present for this audit dir? A present marker — even
 * one that's forged/corrupt — keeps the era active and the legacy fallback
 * off-limits: presence is the fail-closed signal, and a present-but-MAC-invalid
 * marker is itself tamper evidence (we validate the sealed MAC here, but a bad
 * MAC keeps the era ACTIVE — it does not re-open the legacy path). A *deleted*
 * marker no longer downgrades anything: key-presence (hasPersistedAuditKey) and
 * surviving hmac-v1 row tags drive the era decision in verify(), so this is now
 * just one of three independent era signals, not the load-bearing one.
 */
function eraMarkerPresent(markerPath: string): boolean {
  if (existsSync(markerPath) === false) return false;
  // Validate the sealed MAC for tamper-evidence. A forged or corrupt marker
  // still returns true (present == era-active, fail-closed) — the MAC is what
  // stops an attacker RECREATING a *convincing* marker without the key, not a
  // switch that lets a present marker turn the era off. A MAC mismatch is real
  // tamper evidence, so surface it loudly rather than swallowing it.
  try {
    const body = JSON.parse(readFileSync(markerPath, "utf-8")) as { mac?: unknown };
    if (body.mac !== computeAuditMarkerMac(MARKER_PAYLOAD)) {
      logger.warn(`[audit] hmac-v1 era marker present but MAC invalid (forged/corrupt) — era stays active: ${markerPath}`);
    }
  } catch {
    logger.warn(`[audit] hmac-v1 era marker present but unreadable/corrupt — era stays active: ${markerPath}`);
  }
  return true;
}

/**
 * Verify the anchor chain and reconcile it with the main chain heads.
 *
 * A missing anchor file is only benign for a genuinely PRE-KEY / PRE-ANCHORING
 * log (no resolvable seed, no hmac-v1 rows, no era marker) — `anchoringInUse:
 * false` → `checked: false`, verified on the main chain alone with no
 * regression. Once anchoring is in use (`anchoringInUse: true` — caller passes
 * the key-presence-driven `eraActive`, so a resolvable seed alone is enough) an
 * absent anchor file alongside a non-empty audit file is TRUNCATION EVIDENCE —
 * the attacker who drops trailing main-chain lines also deletes the anchor that
 * would pin the true count — so it fails CLOSED rather than degrading to a
 * main-chain-only pass.
 *
 * When an anchor file IS present, every anchor must (a) carry a valid keyed MAC,
 * (b) link to its predecessor, and (c) match the main chain head at its seq —
 * and the anchor count must equal the number of main entries. A short main
 * chain against a longer anchor chain is exactly the tail-truncation this
 * exists to catch; the converse (anchor write lost to a crash) is reported
 * conservatively as broken rather than silently passed.
 */
function verifyAnchors(
  anchorFile: string,
  heads: { seq: number; hash: string }[],
  anchoringInUse: boolean,
): { checked: boolean; broken: boolean; brokenAt?: number } {
  if (existsSync(anchorFile) === false) {
    // Anchoring in use but the anchor file is gone → truncation, fail closed.
    if (anchoringInUse) return { checked: true, broken: true, brokenAt: 0 };
    return { checked: false, broken: false };
  }
  let lines: string[];
  try {
    lines = readFileSync(anchorFile, "utf-8").trim().split("\n").filter(Boolean);
  } catch {
    return { checked: true, broken: true, brokenAt: 0 };
  }

  // Count mismatch = truncation on one side or the other.
  if (lines.length !== heads.length) {
    return { checked: true, broken: true, brokenAt: Math.min(lines.length, heads.length) };
  }

  let prevAnchor = GENESIS_ANCHOR_HASH;
  for (let i = 0; i < lines.length; i++) {
    let a: AnchorRecord;
    try {
      a = JSON.parse(lines[i]) as AnchorRecord;
    } catch {
      return { checked: true, broken: true, brokenAt: i };
    }
    const macOk = computeAnchorHash({ seq: a.seq, count: a.count, chainHash: a.chainHash, prevAnchor: a.prevAnchor }) === a.anchorHash;
    const linkOk = a.prevAnchor === prevAnchor;
    const matchesHead = a.seq === heads[i].seq && a.chainHash === heads[i].hash && a.count === i + 1;
    if (!macOk || !linkOk || !matchesHead) {
      return { checked: true, broken: true, brokenAt: i };
    }
    prevAnchor = a.anchorHash;
  }
  return { checked: true, broken: false };
}

export class CryptoAuditTrail {
  private entries: AuditEntry[] = [];
  private prevHash = GENESIS_PREV_HASH;
  private prevAnchor = GENESIS_ANCHOR_HASH;
  private seq = 0;
  private auditDir: string;
  private fileDate: string;
  // Assigned via resolveForDate() in the constructor (and on each daily
  // rollover); the `!` tells TS the constructor path guarantees them.
  private filePath!: string;
  private anchorPath!: string;
  private markerPath!: string;

  constructor(dataDir: string) {
    this.auditDir = join(dataDir, "audit");
    if (!existsSync(this.auditDir)) mkdirSync(this.auditDir, { recursive: true, mode: 0o700 });
    // Daily audit files — resolve today's file and resume its chains.
    this.fileDate = currentAuditDate();
    this.resolveForDate(this.fileDate);
  }

  /**
   * Point filePath/anchorPath/markerPath at `<auditDir>/<date>.jsonl` and resume
   * seq/prevHash/prevAnchor from that file. For a brand-new day the file does
   * not exist yet, so the chains reset to genesis — exactly the behavior a fresh
   * per-day instance would have. Shared with the constructor so the daily
   * ROLLOVER path (a long-lived shared instance crossing midnight) and first-file
   * resume use one code path.
   */
  private resolveForDate(date: string): void {
    this.fileDate = date;
    this.filePath = join(this.auditDir, `${date}.jsonl`);
    this.anchorPath = anchorPathFor(this.filePath);
    this.markerPath = markerPathFor(this.filePath);
    this.prevHash = GENESIS_PREV_HASH;
    this.prevAnchor = GENESIS_ANCHOR_HASH;
    this.seq = 0;
    // Resume chain from existing file
    if (existsSync(this.filePath)) {
      try {
        const lines = readFileSync(this.filePath, "utf-8").trim().split("\n");
        const lastLine = lines[lines.length - 1];
        if (lastLine) {
          const lastEntry = JSON.parse(lastLine) as AuditEntry;
          this.prevHash = lastEntry.hash;
          this.seq = lastEntry.seq + 1;
        }
      } catch { /* Start fresh if corrupt */ }
    }
    // Resume the independent anchor chain from its last record.
    if (existsSync(this.anchorPath)) {
      try {
        const lines = readFileSync(this.anchorPath, "utf-8").trim().split("\n");
        const last = lines[lines.length - 1];
        if (last) this.prevAnchor = (JSON.parse(last) as AnchorRecord).anchorHash;
      } catch { /* Start anchor chain fresh if corrupt */ }
    }
  }

  /** Record an audit entry with cryptographic chaining */
  record(entry: Omit<AuditEntry, "seq" | "hash" | "prevHash" | "timestamp">): AuditEntry {
    // Daily rollover: a long-lived (shared) instance must not keep appending to
    // a stale date after midnight. If the calendar day has advanced, re-resolve
    // to the new day's file and resume its chains (genesis for a brand-new day).
    // Done synchronously before computing the entry so seq/prevHash reflect the
    // file we're about to write.
    const today = currentAuditDate();
    if (today !== this.fileDate) this.resolveForDate(today);

    const full: AuditEntry = {
      ...entry,
      seq: this.seq++,
      timestamp: new Date().toISOString(),
      prevHash: this.prevHash,
      hash: "", // computed below
      hashScheme: "hmac-v1",
    };

    // HMAC-SHA256 over the canonical payload of ALL security-relevant fields
    // (decision, reason, role, threatScore, dataLabels, …). Keyed so a
    // filesystem-only attacker can't forge a valid chain.
    full.hash = computeEntryHash(full);
    this.prevHash = full.hash;

    this.entries.push(full);

    // First hmac-v1 write enters the "hmac-v1 era" — persist the sealed marker
    // so verify() can refuse the unkeyed legacy fallback from here on. Best
    // effort: a marker write failure must not crash the agent, and the chain
    // still verifies as hmac-v1 on its own scheme tags.
    try {
      writeEraMarker(this.markerPath);
    } catch { /* marker write failure shouldn't crash the agent */ }

    // Append to daily file (JSONL format)
    try {
      writeFileSync(this.filePath, JSON.stringify(full) + "\n", { flag: "a", mode: 0o600 });
    } catch { /* Audit write failure shouldn't crash the agent */ }

    // External anchor: pin the new chain head in the independent anchor chain
    // and emit it to the app log. The on-disk anchor catches tail-truncation;
    // the emitted head is the off-box copy a log shipper can hold.
    const anchor: AnchorRecord = {
      seq: full.seq,
      count: full.seq + 1,
      chainHash: full.hash,
      prevAnchor: this.prevAnchor,
      anchorHash: "",
    };
    anchor.anchorHash = computeAnchorHash(anchor);
    this.prevAnchor = anchor.anchorHash;
    try {
      writeFileSync(this.anchorPath, JSON.stringify(anchor) + "\n", { flag: "a", mode: 0o600 });
    } catch { /* Anchor write failure shouldn't crash the agent */ }
    logger.info(`[audit-anchor] seq=${anchor.seq} count=${anchor.count} head=${anchor.chainHash}`);

    return full;
  }

  /**
   * Verify the integrity of the audit chain.
   *
   * Fail-closed era gate, driven by KEY PRESENCE (the C3 ratchet): the audit dir
   * is in the "hmac-v1 era" if a real persisted/env audit seed is resolvable
   * (hasPersistedAuditKey), OR the sealed `.hmac-v1.marker` is present, OR the
   * chain itself still contains any hmac-v1 row. In the era, EVERY entry must be
   * `hashScheme: "hmac-v1"` and is recomputed with the keyed HMAC, so the unkeyed
   * legacy SHA-256 branch is UNREACHABLE.
   *
   * Key-presence is the load-bearing signal: a keyed install signs 100% hmac-v1,
   * so even if a filesystem-only attacker DELETES the marker AND the anchor and
   * rewrites every row as a self-consistent plain-SHA-256 chain (no key needed),
   * the seed still resolves → era still active → that downgrade returns
   * `valid:false`. The marker and row-tag signals are now belt-and-suspenders;
   * deleting them can't re-open the legacy path.
   *
   * The legacy branch survives ONLY for the genuine pre-key back-compat window:
   * NO seed resolvable, NO marker, NO hmac-v1 rows. There an old pre-upgrade dev
   * file still verifies under plain SHA-256 so boot never crashes. A keyed
   * install is 100% hmac-v1.
   */
  static verify(filePath: string): { valid: boolean; brokenAt?: number; total: number; anchorChecked?: boolean } {
    if (existsSync(filePath) === false) return { valid: true, total: 0 };
    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    let prevHash = GENESIS_PREV_HASH;
    const heads: { seq: number; hash: string }[] = [];

    // hmac-v1 era is active if a real persisted/env audit seed is resolvable,
    // OR the sealed marker exists, OR any row is still tagged hmac-v1. Key
    // presence is the primary ratchet (C3): a keyed install is 100% hmac-v1, so
    // deleting the marker + anchor and rewriting every row as self-consistent
    // plain-SHA-256 (no key needed) can't downgrade past it — the seed still
    // resolves and the legacy fallback stays off-limits. The marker and row-tag
    // checks are the back-compat catch for files predating the key.
    const markerPath = markerPathFor(filePath);
    const parsed: (AuditEntry | null)[] = lines.map(l => {
      try { return JSON.parse(l) as AuditEntry; } catch { return null; }
    });
    const eraActive =
      hasPersistedAuditKey() ||
      eraMarkerPresent(markerPath) ||
      parsed.some(e => e !== null && e.hashScheme === "hmac-v1");

    for (let i = 0; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]) as AuditEntry;

        // Era gate: in the hmac-v1 era, refuse any non-hmac-v1 row. This is the
        // line that closes the legacy-downgrade forge — the unkeyed branch
        // below is unreachable once the era is active.
        if (eraActive && entry.hashScheme !== "hmac-v1") {
          return { valid: false, brokenAt: i, total: lines.length };
        }

        // Reject NULL/empty anchors except the single legitimate genesis row.
        // Only index 0 may carry the GENESIS anchor; any later GENESIS/empty
        // prevHash means the chain was truncated or re-rooted.
        const anchorEmpty = entry.prevHash == null || entry.prevHash === "";
        if (anchorEmpty || (i > 0 && entry.prevHash === GENESIS_PREV_HASH)) {
          return { valid: false, brokenAt: i, total: lines.length };
        }

        if (entry.prevHash !== prevHash) {
          return { valid: false, brokenAt: i, total: lines.length };
        }

        const computed =
          entry.hashScheme === "hmac-v1"
            ? computeEntryHash(entry)
            : createHash("sha256").update(legacyPayload(entry)).digest("hex");
        if (computed !== entry.hash) {
          return { valid: false, brokenAt: i, total: lines.length };
        }
        heads.push({ seq: entry.seq, hash: entry.hash });
        prevHash = entry.hash;
      } catch {
        return { valid: false, brokenAt: i, total: lines.length };
      }
    }

    // Cross-check against the external anchor chain. The linear chain above
    // can't detect tail-truncation (a valid prefix is still a valid chain);
    // the anchor file pins (seq, head, count) so a dropped tail no longer
    // matches. `eraActive` here is key-presence-driven, so in the keyed era an
    // ABSENT anchor file beside a non-empty audit file is itself truncation
    // evidence and fails closed — the attacker who drops the tail also deletes
    // the anchor. Only a genuine pre-key/pre-anchoring log (no seed, no era,
    // no anchor) skips the cross-check.
    const anchorResult = verifyAnchors(anchorPathFor(filePath), heads, eraActive);
    if (anchorResult.broken) {
      return { valid: false, brokenAt: anchorResult.brokenAt, total: lines.length, anchorChecked: true };
    }
    return { valid: true, total: lines.length, anchorChecked: anchorResult.checked };
  }

  getRecent(count: number = 20): AuditEntry[] {
    return this.entries.slice(-count);
  }
}

// ═══════════════════════════════════════════════════════════════════
// SHARED SINGLE-WRITER REGISTRY (finding H10)
// ═══════════════════════════════════════════════════════════════════
//
// Multiple independent writers (declassify in data-lineage, canary-exfil in
// canaries, every per-turn ThreatEngine) all target the SAME daily audit file.
// Each `new CryptoAuditTrail` only resumes the chain head in its constructor,
// then mutates its OWN in-memory seq/prevHash and blind-appends. Two live
// instances at the same head write conflicting prevHash/seq (and colliding
// anchor counts), permanently breaking verify() during NORMAL operation — a
// denial-of-integrity an attacker can trigger by interleaving writes.
//
// Fix: hand every writer for a given audit location the SAME instance. record()
// is synchronous (no await between reading prevHash and appending), so Node's
// single thread naturally serializes interleaved record() calls on one shared
// instance — no lock needed.
//
// Concurrency honesty: this closes the SAME-PROCESS multi-instance desync, which
// is the actual bug. The app writes audit from a single process, so that's the
// whole exposure. It does NOT add cross-PROCESS file locking — if two OS
// processes ever wrote this file concurrently they could still race the append;
// that's out of scope here (no flock) because no such second writer exists.
const sharedAuditTrails = new Map<string, CryptoAuditTrail>();

/**
 * Return the process-wide SHARED CryptoAuditTrail for `<dataDir>/audit`,
 * constructing it once and memoizing per resolved audit location. Repeated calls
 * for the same dataDir return the SAME object, so all writers for one daily file
 * stay on a single serialized chain head.
 */
export function getSharedAuditTrail(dataDir: string): CryptoAuditTrail {
  const key = join(dataDir, "audit");
  let trail = sharedAuditTrails.get(key);
  if (!trail) {
    trail = new CryptoAuditTrail(dataDir);
    sharedAuditTrails.set(key, trail);
  }
  return trail;
}
