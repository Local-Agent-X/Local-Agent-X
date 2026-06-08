import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { computeAuditMarkerMac, getAuditHmacKey } from "../app-runtime/audit-signing.js";
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
 * off-limits: presence alone is the fail-closed signal, and a present-but-
 * invalid marker is itself tamper evidence. (The MAC is what stops an attacker
 * RECREATING a convincing marker after deletion; it can't validate without the
 * key.) An attacker who deletes the marker still can't downgrade a chain that
 * retains any hmac-v1 row — verify() reads the row tags as the second era
 * signal.
 */
function eraMarkerPresent(markerPath: string): boolean {
  return existsSync(markerPath);
}

/**
 * Verify the anchor chain and reconcile it with the main chain heads.
 *
 * A missing anchor file is only benign for a genuinely PRE-ANCHORING log (no
 * hmac-v1 rows, no era marker) — `anchoringInUse: false` → `checked: false`,
 * verified on the main chain alone with no regression. Once anchoring is in use
 * (`anchoringInUse: true`, i.e. hmac-v1 data or the marker is present) an absent
 * anchor file is TRUNCATION EVIDENCE — the attacker who drops trailing main-chain
 * lines also deletes the anchor that would pin the true count — so it fails
 * CLOSED rather than degrading to a main-chain-only pass.
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
  private filePath: string;
  private anchorPath: string;
  private markerPath: string;

  constructor(dataDir: string) {
    const auditDir = join(dataDir, "audit");
    if (!existsSync(auditDir)) mkdirSync(auditDir, { recursive: true, mode: 0o700 });
    // Daily audit files
    const date = new Date().toISOString().slice(0, 10);
    this.filePath = join(auditDir, `${date}.jsonl`);
    this.anchorPath = anchorPathFor(this.filePath);
    this.markerPath = markerPathFor(this.filePath);
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
   * Fail-closed era gate: once the audit dir has entered the "hmac-v1 era"
   * (the sealed `.hmac-v1.marker` is present, OR the chain itself contains any
   * hmac-v1 row), EVERY entry must be `hashScheme: "hmac-v1"` and is recomputed
   * with the keyed HMAC. The unkeyed legacy SHA-256 branch is then UNREACHABLE,
   * so an attacker can't rewrite the file as self-consistent plain-SHA-256 rows
   * (no key needed) and have it pass — that downgrade now returns `valid:false`.
   *
   * The legacy branch survives ONLY for the genuine pre-marker back-compat
   * window: an old dev file with NO marker and NO hmac-v1 rows. There it still
   * verifies under plain SHA-256 so an existing pre-upgrade audit file validates
   * and boot never crashes. A fresh install is 100% hmac-v1.
   */
  static verify(filePath: string): { valid: boolean; brokenAt?: number; total: number; anchorChecked?: boolean } {
    if (existsSync(filePath) === false) return { valid: true, total: 0 };
    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    let prevHash = GENESIS_PREV_HASH;
    const heads: { seq: number; hash: string }[] = [];

    // hmac-v1 era is active if the sealed marker exists OR any row is tagged
    // hmac-v1. Either makes the legacy fallback off-limits for the whole chain
    // (deleting the marker doesn't downgrade a chain that still has hmac-v1
    // rows; rewriting every row as legacy is exactly the C1 attack we reject).
    const markerPath = markerPathFor(filePath);
    const parsed: (AuditEntry | null)[] = lines.map(l => {
      try { return JSON.parse(l) as AuditEntry; } catch { return null; }
    });
    const eraActive =
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
    // matches. Once anchoring is in use (hmac-v1 era), an ABSENT anchor file is
    // itself truncation evidence and fails closed — the attacker who drops the
    // tail also deletes the anchor. Only a genuine pre-anchoring log (no era,
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
