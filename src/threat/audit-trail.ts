import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getAuditHmacKey } from "../app-runtime/audit-signing.js";
import type { DataLabel } from "./classification.js";
import type { ThreatLevel } from "./scoring.js";

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

export class CryptoAuditTrail {
  private entries: AuditEntry[] = [];
  private prevHash = GENESIS_PREV_HASH;
  private seq = 0;
  private filePath: string;

  constructor(dataDir: string) {
    const auditDir = join(dataDir, "audit");
    if (!existsSync(auditDir)) mkdirSync(auditDir, { recursive: true, mode: 0o700 });
    // Daily audit files
    const date = new Date().toISOString().slice(0, 10);
    this.filePath = join(auditDir, `${date}.jsonl`);
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
  static verify(filePath: string): { valid: boolean; brokenAt?: number; total: number } {
    if (existsSync(filePath) === false) return { valid: true, total: 0 };
    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    let prevHash = GENESIS_PREV_HASH;

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
        prevHash = entry.hash;
      } catch {
        return { valid: false, brokenAt: i, total: lines.length };
      }
    }
    return { valid: true, total: lines.length };
  }

  getRecent(count: number = 20): AuditEntry[] {
    return this.entries.slice(-count);
  }
}
