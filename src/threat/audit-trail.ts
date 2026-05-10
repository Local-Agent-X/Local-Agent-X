import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DataLabel } from "./classification.js";
import type { ThreatLevel } from "./scoring.js";

// ═══════════════════════════════════════════════════════════════════
// CRYPTOGRAPHIC AUDIT TRAIL — Hash-chained tamper-evident log
// ═══════════════════════════════════════════════════════════════════

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
  hash: string;        // SHA-256 of this entry
  prevHash: string;    // Hash of previous entry (chain)
}

export class CryptoAuditTrail {
  private entries: AuditEntry[] = [];
  private prevHash = "GENESIS";
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
    };

    // Hash = SHA-256(seq + timestamp + prevHash + event data)
    const payload = JSON.stringify({
      seq: full.seq,
      timestamp: full.timestamp,
      sessionId: full.sessionId,
      event: full.event,
      toolName: full.toolName,
      decision: full.decision,
      reason: full.reason,
      prevHash: full.prevHash,
    });
    full.hash = createHash("sha256").update(payload).digest("hex");
    this.prevHash = full.hash;

    this.entries.push(full);

    // Append to daily file (JSONL format)
    try {
      writeFileSync(this.filePath, JSON.stringify(full) + "\n", { flag: "a", mode: 0o600 });
    } catch { /* Audit write failure shouldn't crash the agent */ }

    return full;
  }

  /** Verify the integrity of the audit chain */
  static verify(filePath: string): { valid: boolean; brokenAt?: number; total: number } {
    if (!existsSync(filePath)) return { valid: true, total: 0 };
    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    let prevHash = "GENESIS";

    for (let i = 0; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]) as AuditEntry;
        if (entry.prevHash !== prevHash) {
          return { valid: false, brokenAt: i, total: lines.length };
        }
        // Recompute hash
        const payload = JSON.stringify({
          seq: entry.seq,
          timestamp: entry.timestamp,
          sessionId: entry.sessionId,
          event: entry.event,
          toolName: entry.toolName,
          decision: entry.decision,
          reason: entry.reason,
          prevHash: entry.prevHash,
        });
        const computed = createHash("sha256").update(payload).digest("hex");
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
