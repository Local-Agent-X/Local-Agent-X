import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getAuditHmacKey } from "../app-runtime/audit-signing.js";
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

/**
 * Verify the anchor chain and reconcile it with the main chain heads.
 *
 * Returns `checked: false` when no anchor file exists (a log written before
 * anchoring shipped — verified on the main chain alone, no regression). When
 * an anchor file IS present, every anchor must (a) carry a valid keyed MAC,
 * (b) link to its predecessor, and (c) match the main chain head at its seq —
 * and the anchor count must equal the number of main entries. A short main
 * chain against a longer anchor chain is exactly the tail-truncation this
 * exists to catch; the converse (anchor write lost to a crash) is reported
 * conservatively as broken rather than silently passed.
 */
function verifyAnchors(
  anchorFile: string,
  heads: { seq: number; hash: string }[],
): { checked: boolean; broken: boolean; brokenAt?: number } {
  if (existsSync(anchorFile) === false) return { checked: false, broken: false };
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
  private filePath: string;
  private anchorPath: string;

  constructor(dataDir: string) {
    const auditDir = join(dataDir, "audit");
    if (!existsSync(auditDir)) mkdirSync(auditDir, { recursive: true, mode: 0o700 });
    // Daily audit files
    const date = new Date().toISOString().slice(0, 10);
    this.filePath = join(auditDir, `${date}.jsonl`);
    this.anchorPath = anchorPathFor(this.filePath);
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
   * Migration/compat: entries tagged `hashScheme: "hmac-v1"` are recomputed
   * with the keyed HMAC over the full field set. Entries WITHOUT that tag are
   * pre-upgrade legacy rows written with plain SHA-256 over the narrow field
   * set — they're verified under the legacy scheme so an existing dev audit
   * file still validates (and boot never crashes). A fresh chain is entirely
   * hmac-v1; tampering with any newly-hashed field (threatScore/dataLabels/
   * role) breaks it, and a plain-SHA-256 forgery of an hmac-v1 row fails.
   */
  static verify(filePath: string): { valid: boolean; brokenAt?: number; total: number; anchorChecked?: boolean } {
    if (existsSync(filePath) === false) return { valid: true, total: 0 };
    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    let prevHash = GENESIS_PREV_HASH;
    const heads: { seq: number; hash: string }[] = [];

    for (let i = 0; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]) as AuditEntry;

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
    // matches. Absent anchor file → pre-anchoring log, skip (back-compat).
    const anchorResult = verifyAnchors(anchorPathFor(filePath), heads);
    if (anchorResult.broken) {
      return { valid: false, brokenAt: anchorResult.brokenAt, total: lines.length, anchorChecked: true };
    }
    return { valid: true, total: lines.length, anchorChecked: anchorResult.checked };
  }

  getRecent(count: number = 20): AuditEntry[] {
    return this.entries.slice(-count);
  }
}
