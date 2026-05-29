/**
 * ARI Audit Log Viewer API
 *
 * Query, filter, and paginate the cryptographic audit log.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ThreatLevel, DataLabel } from "../threat/threat-engine.js";
import { getLaxDir } from "../lax-data-dir.js";

interface AuditEntry {
  seq: number;
  timestamp: string;
  sessionId: string;
  event: string;
  toolName?: string;
  decision: "allow" | "block" | "warn";
  reason: string;
  role?: string;
  controlsApplied?: string[];
  threatScore?: number;
  threatLevel?: ThreatLevel;
  dataLabels?: DataLabel[];
  hash: string;
  prevHash: string;
}

export interface AuditQuery {
  /** Filter by session ID */
  sessionId?: string;
  /** Filter by decision */
  decision?: "allow" | "block" | "warn";
  /** Filter by tool name */
  toolName?: string;
  /** Filter by event type */
  event?: string;
  /** Filter by threat level */
  threatLevel?: ThreatLevel;
  /** Filter by date range (ISO strings) */
  startDate?: string;
  endDate?: string;
  /** Search in reason text */
  search?: string;
  /** Pagination */
  page?: number;
  pageSize?: number;
  /** Sort direction */
  sortOrder?: "asc" | "desc";
}

export interface AuditPage {
  entries: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function getAuditDir(): string {
  return join(getLaxDir(), "audit");
}

/** List available audit log dates */
export function listAuditDates(): string[] {
  const dir = getAuditDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith(".jsonl"))
    .map(f => f.replace(".jsonl", ""))
    .sort()
    .reverse();
}

/** Load all entries from a specific date's audit log */
export function loadAuditLog(date: string): AuditEntry[] {
  const filePath = join(getAuditDir(), `${date}.jsonl`);
  if (!existsSync(filePath)) return [];
  try {
    return readFileSync(filePath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line) as AuditEntry);
  } catch {
    return [];
  }
}

/** Load entries from all audit logs within a date range */
function loadEntriesInRange(startDate?: string, endDate?: string): AuditEntry[] {
  const dates = listAuditDates();
  const filtered = dates.filter(d => {
    if (startDate && d < startDate) return false;
    if (endDate && d > endDate) return false;
    return true;
  });
  const entries: AuditEntry[] = [];
  for (const date of filtered) {
    entries.push(...loadAuditLog(date));
  }
  return entries;
}

/** Query and paginate audit log entries */
export function queryAuditLog(query: AuditQuery = {}): AuditPage {
  const { page = 1, pageSize = 50, sortOrder = "desc" } = query;

  let entries = loadEntriesInRange(query.startDate, query.endDate);

  // Apply filters
  if (query.sessionId) {
    entries = entries.filter(e => e.sessionId === query.sessionId);
  }
  if (query.decision) {
    entries = entries.filter(e => e.decision === query.decision);
  }
  if (query.toolName) {
    entries = entries.filter(e => e.toolName === query.toolName);
  }
  if (query.event) {
    entries = entries.filter(e => e.event === query.event);
  }
  if (query.threatLevel) {
    entries = entries.filter(e => e.threatLevel === query.threatLevel);
  }
  if (query.search) {
    const term = query.search.toLowerCase();
    entries = entries.filter(e => e.reason.toLowerCase().includes(term));
  }

  // Sort
  entries.sort((a, b) => {
    const cmp = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    return sortOrder === "desc" ? -cmp : cmp;
  });

  const total = entries.length;
  const totalPages = Math.ceil(total / pageSize);
  const start = (page - 1) * pageSize;
  const paged = entries.slice(start, start + pageSize);

  return { entries: paged, total, page, pageSize, totalPages };
}

/** Get summary statistics from audit logs */
export function getAuditSummary(startDate?: string, endDate?: string): {
  totalEntries: number;
  decisions: Record<string, number>;
  topTools: Array<{ tool: string; count: number }>;
  topEvents: Array<{ event: string; count: number }>;
  threatLevelDistribution: Record<string, number>;
} {
  const entries = loadEntriesInRange(startDate, endDate);
  const decisions: Record<string, number> = {};
  const tools: Record<string, number> = {};
  const events: Record<string, number> = {};
  const levels: Record<string, number> = {};

  for (const e of entries) {
    decisions[e.decision] = (decisions[e.decision] || 0) + 1;
    if (e.toolName) tools[e.toolName] = (tools[e.toolName] || 0) + 1;
    events[e.event] = (events[e.event] || 0) + 1;
    if (e.threatLevel) levels[e.threatLevel] = (levels[e.threatLevel] || 0) + 1;
  }

  const topTools = Object.entries(tools).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([tool, count]) => ({ tool, count }));
  const topEvents = Object.entries(events).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([event, count]) => ({ event, count }));

  return { totalEntries: entries.length, decisions, topTools, topEvents, threatLevelDistribution: levels };
}
