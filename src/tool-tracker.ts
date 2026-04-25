import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

interface ToolCallRecord {
  name: string;
  sessionId: string;
  timestamp: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

interface ToolStatsEntry {
  totalCalls: number;
  successes: number;
  failures: number;
  avgDurationMs: number;
  lastFailure?: string;
  lastFailureTime?: number;
}

type ToolStats = Record<string, ToolStatsEntry>;

const MAX_ENTRIES = 10000;
const LAX_DIR = join(homedir(), ".lax");
const STATS_FILE = join(LAX_DIR, "tool-stats.json");

const records: ToolCallRecord[] = [];

function ensureDir(): void {
  if (!existsSync(LAX_DIR)) {
    mkdirSync(LAX_DIR, { recursive: true });
  }
}

function persistSummary(): void {
  ensureDir();
  const stats = getToolStats();
  writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), "utf-8");
}

export function recordToolCall(
  name: string,
  sessionId: string,
  success: boolean,
  durationMs: number,
  error?: string,
): void {
  const record: ToolCallRecord = {
    name,
    sessionId,
    timestamp: Date.now(),
    durationMs,
    success,
    error,
  };

  records.push(record);

  if (records.length > MAX_ENTRIES) {
    records.splice(0, records.length - MAX_ENTRIES);
  }

  persistSummary();
}

export function getToolStats(): ToolStats {
  const stats: ToolStats = {};

  for (const r of records) {
    if (!stats[r.name]) {
      stats[r.name] = { totalCalls: 0, successes: 0, failures: 0, avgDurationMs: 0 };
    }
    const entry = stats[r.name];
    entry.avgDurationMs =
      (entry.avgDurationMs * entry.totalCalls + r.durationMs) / (entry.totalCalls + 1);
    entry.totalCalls++;
    if (r.success) {
      entry.successes++;
    } else {
      entry.failures++;
      entry.lastFailure = r.error;
      entry.lastFailureTime = r.timestamp;
    }
  }

  return stats;
}

export function getToolSuccessRate(toolName?: string): number {
  const filtered = toolName ? records.filter((r) => r.name === toolName) : records;
  if (filtered.length === 0) return 1;
  const successes = filtered.filter((r) => r.success).length;
  return successes / filtered.length;
}

export function getRecentFailures(limit: number = 10): ToolCallRecord[] {
  return records
    .filter((r) => !r.success)
    .slice(-limit);
}

export function loadPersistedStats(): ToolStats | null {
  try {
    if (existsSync(STATS_FILE)) {
      return JSON.parse(readFileSync(STATS_FILE, "utf-8"));
    }
  } catch {
    // ignore corrupted file
  }
  return null;
}
