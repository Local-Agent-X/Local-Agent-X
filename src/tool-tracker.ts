import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "./lax-data-dir.js";

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
const LAX_DIR = getLaxDir();
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

// ── Per-category op-outcome telemetry ──
// tool-stats above answers "does this tool work?". This answers "do we finish
// the task?" — the signal the completion gates (decide-outcome.ts) need to know
// which categories give up, instead of guessing from anecdotes.

export type OpCategory = "browser" | "computer" | "coding" | "connector" | "research" | "general";
export type OpOutcome = "clean" | "partial" | "aborted";

// First family with a tool used wins, so an op that browsed and then web-fetched
// still reads as "browser" — the drive category the gates care about. No match →
// "general".
const CATEGORY_TOOLS: ReadonlyArray<readonly [OpCategory, readonly string[]]> = [
  ["browser", ["browser"]],
  ["computer", ["computer", "computer_click", "computer_type", "computer_press", "computer_move", "computer_drag", "computer_position", "screen_capture"]],
  ["coding", ["write", "edit", "edit_lines", "multi_edit", "bash", "build_app", "delete_file"]],
  ["connector", ["email_send", "email_draft", "telegram_send", "whatsapp_send", "connector_create", "send_image", "send_video"]],
  ["research", ["web_search", "web_fetch", "http_request", "image_search", "youtube_analyze"]],
];

export function classifyOpCategory(toolsUsed: Set<string>): OpCategory {
  for (const [category, names] of CATEGORY_TOOLS) {
    if (names.some((n) => toolsUsed.has(n))) return category;
  }
  return "general";
}

interface OpOutcomeEntry { total: number; clean: number; partial: number; aborted: number; }
type OpOutcomeStats = Partial<Record<OpCategory, OpOutcomeEntry>>;

const opOutcomes: { category: OpCategory; outcome: OpOutcome }[] = [];

export function recordOpOutcome(category: OpCategory, outcome: OpOutcome): void {
  opOutcomes.push({ category, outcome });
  if (opOutcomes.length > MAX_ENTRIES) {
    opOutcomes.splice(0, opOutcomes.length - MAX_ENTRIES);
  }
  // Resolve the dir at write time (not module load) so a late LAX_DATA_DIR — and
  // tests that set it after import — land in the right place.
  const dir = getLaxDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "op-outcomes.json"), JSON.stringify(getOpOutcomeStats(), null, 2), "utf-8");
}

export function getOpOutcomeStats(): OpOutcomeStats {
  const stats: OpOutcomeStats = {};
  for (const { category, outcome } of opOutcomes) {
    const entry = (stats[category] ??= { total: 0, clean: 0, partial: 0, aborted: 0 });
    entry.total++;
    entry[outcome]++;
  }
  return stats;
}
