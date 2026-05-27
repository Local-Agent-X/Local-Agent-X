/**
 * File Access Audit Trail
 *
 * Logs every file read/write with timestamps for security auditing.
 */

import { writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getLaxDir } from "./lax-data-dir.js";

export interface FileAccessEntry {
  timestamp: string;
  sessionId: string;
  operation: "read" | "write" | "edit" | "delete";
  filePath: string;
  fileHash?: string;
  sizeBytes?: number;
  blocked: boolean;
  reason?: string;
}

interface FileAuditQuery {
  sessionId?: string;
  operation?: "read" | "write" | "edit" | "delete";
  filePath?: string;
  startDate?: string;
  endDate?: string;
  blockedOnly?: boolean;
  limit?: number;
}

class FileAuditTrail {
  private entries: FileAccessEntry[] = [];
  private logDir: string;
  private readonly MAX_ENTRIES = 5000;

  constructor() {
    this.logDir = join(getLaxDir(), "audit", "file-access");
    if (!existsSync(this.logDir)) mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
  }

  /** Record a file access event */
  record(entry: Omit<FileAccessEntry, "timestamp">): FileAccessEntry {
    const full: FileAccessEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };

    this.entries.push(full);
    if (this.entries.length > this.MAX_ENTRIES) this.entries.shift();

    // Append to daily log
    const date = new Date().toISOString().slice(0, 10);
    const filePath = join(this.logDir, `${date}.jsonl`);
    try {
      writeFileSync(filePath, JSON.stringify(full) + "\n", { flag: "a" });
    } catch { /* non-fatal */ }

    return full;
  }

  /** Query file access entries */
  query(q: FileAuditQuery = {}): FileAccessEntry[] {
    let results = [...this.entries];

    if (q.sessionId) results = results.filter(e => e.sessionId === q.sessionId);
    if (q.operation) results = results.filter(e => e.operation === q.operation);
    if (q.filePath) results = results.filter(e => e.filePath.includes(q.filePath!));
    if (q.blockedOnly) results = results.filter(e => e.blocked);
    if (q.startDate) results = results.filter(e => e.timestamp >= q.startDate!);
    if (q.endDate) results = results.filter(e => e.timestamp <= q.endDate!);

    results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    if (q.limit) results = results.slice(0, q.limit);
    return results;
  }

  /** Get recent file access entries */
  getRecent(count: number = 20): FileAccessEntry[] {
    return this.entries.slice(-count).reverse();
  }

  /** Get file access summary */
  getSummary(): {
    totalReads: number;
    totalWrites: number;
    totalBlocked: number;
    uniqueFiles: number;
    topFiles: Array<{ path: string; count: number }>;
  } {
    const reads = this.entries.filter(e => e.operation === "read").length;
    const writes = this.entries.filter(e => e.operation === "write" || e.operation === "edit").length;
    const blocked = this.entries.filter(e => e.blocked).length;
    const files = new Set(this.entries.map(e => e.filePath));
    const fileCounts: Record<string, number> = {};
    for (const e of this.entries) {
      fileCounts[e.filePath] = (fileCounts[e.filePath] || 0) + 1;
    }
    const topFiles = Object.entries(fileCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([path, count]) => ({ path, count }));

    return { totalReads: reads, totalWrites: writes, totalBlocked: blocked, uniqueFiles: files.size, topFiles };
  }

  /** Load historical entries from disk */
  loadFromDisk(date: string): FileAccessEntry[] {
    const filePath = join(this.logDir, `${date}.jsonl`);
    if (!existsSync(filePath)) return [];
    try {
      return readFileSync(filePath, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }
}

// Singleton
const fileAudit = new FileAuditTrail();

export function recordFileAccess(entry: Omit<FileAccessEntry, "timestamp">): FileAccessEntry {
  return fileAudit.record(entry);
}

export function queryFileAccess(query?: FileAuditQuery): FileAccessEntry[] {
  return fileAudit.query(query);
}

export function getRecentFileAccess(count?: number): FileAccessEntry[] {
  return fileAudit.getRecent(count);
}

export function getFileAccessSummary() {
  return fileAudit.getSummary();
}

export function hashFileContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
