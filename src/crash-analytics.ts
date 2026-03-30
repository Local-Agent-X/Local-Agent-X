import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface CrashEntry {
  id: string;
  message: string;
  stack?: string;
  context: Record<string, unknown>;
  timestamp: number;
  pattern: string;
}

interface CrashLog {
  entries: CrashEntry[];
}

interface CrashPattern {
  pattern: string;
  count: number;
  lastOccurrence: number;
  sampleMessage: string;
}

const MAX_ENTRIES = 500;

function logPath(): string {
  return join(homedir(), ".sax", "crash-log.json");
}

function loadLog(): CrashLog {
  const p = logPath();
  if (!existsSync(p)) return { entries: [] };
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return { entries: [] };
  }
}

function saveLog(log: CrashLog): void {
  const dir = join(homedir(), ".sax");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(logPath(), JSON.stringify(log, null, 2), "utf-8");
}

function extractPattern(message: string): string {
  // Normalize error messages by removing variable parts
  return message
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\b\d+\b/g, "<N>")
    .replace(/"[^"]*"/g, '"<str>"')
    .replace(/'[^']*'/g, "'<str>'")
    .replace(/\/[^\s]+/g, "<path>")
    .trim();
}

function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(4).toString("hex");
  return `${ts}-${rand}`;
}

export function recordCrash(
  error: Error | string,
  context: Record<string, unknown> = {},
): CrashEntry {
  const message = error instanceof Error ? error.message : error;
  const stack = error instanceof Error ? error.stack : undefined;

  const entry: CrashEntry = {
    id: generateId(),
    message,
    stack,
    context,
    timestamp: Date.now(),
    pattern: extractPattern(message),
  };

  const log = loadLog();
  log.entries.push(entry);

  // Trim to max entries, keeping newest
  if (log.entries.length > MAX_ENTRIES) {
    log.entries = log.entries.slice(log.entries.length - MAX_ENTRIES);
  }

  saveLog(log);
  return entry;
}

export function getCrashReport(): {
  totalCrashes: number;
  uniquePatterns: number;
  patterns: CrashPattern[];
  recentEntries: CrashEntry[];
} {
  const log = loadLog();
  const patternMap = new Map<string, CrashPattern>();

  for (const entry of log.entries) {
    const existing = patternMap.get(entry.pattern);
    if (existing) {
      existing.count++;
      if (entry.timestamp > existing.lastOccurrence) {
        existing.lastOccurrence = entry.timestamp;
        existing.sampleMessage = entry.message;
      }
    } else {
      patternMap.set(entry.pattern, {
        pattern: entry.pattern,
        count: 1,
        lastOccurrence: entry.timestamp,
        sampleMessage: entry.message,
      });
    }
  }

  const patterns = Array.from(patternMap.values()).sort((a, b) => b.count - a.count);
  const recentEntries = log.entries.slice(-20).reverse();

  return {
    totalCrashes: log.entries.length,
    uniquePatterns: patterns.length,
    patterns,
    recentEntries,
  };
}

export function getTopCrashPatterns(limit: number = 10): CrashPattern[] {
  const report = getCrashReport();
  return report.patterns.slice(0, limit);
}
