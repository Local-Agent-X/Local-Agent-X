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

// ── Op-outcome telemetry (per category × model) ──
// tool-stats above answers "does this tool work?". This answers "do we finish
// the task?" — the signal Phase B needs: which categories AND which providers
// give up. Keyed by category and model because a blended "browser 60% clean"
// across Grok + Claude is meaningless — separating them is the whole question.

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

/**
 * Normalize a tool name observed out of band (CLI/MCP path) to its canonical
 * LAX name so the category table matches it. LAX tools reach the `claude`
 * subprocess as `mcp__<server>__<tool>` (e.g. mcp__lax__web_search); the
 * <tool> segment is the canonical name. The one enabled native CLI tool,
 * Anthropic's server-side `WebSearch`, maps to LAX's research bucket via
 * web_search. Bare/already-canonical names pass through unchanged, so this is
 * a no-op for tools the canonical loop dispatched itself.
 */
export function normalizeObservedToolName(raw: string): string {
  if (raw.startsWith("mcp__")) {
    const parts = raw.split("__");
    if (parts.length >= 3) return parts.slice(2).join("__");
  }
  if (raw === "WebSearch") return "web_search";
  return raw;
}

export function classifyOpCategory(toolsUsed: Set<string>): OpCategory {
  const normalized = new Set([...toolsUsed].map(normalizeObservedToolName));
  for (const [category, names] of CATEGORY_TOOLS) {
    if (names.some((n) => normalized.has(n))) return category;
  }
  return "general";
}

interface OpOutcomeEntry { total: number; clean: number; partial: number; aborted: number; }
/** Keyed by `${category}::${model}`. Counts are additive, so seeding from the
 *  on-disk aggregate and incrementing in memory survives restarts cleanly — the
 *  app restarts constantly (OTA, quit/reopen), and without this every restart
 *  reset the file to the current session. */
type OpOutcomeStats = Record<string, OpOutcomeEntry>;

const OP_OUTCOMES_FILE = "op-outcomes.json";
let opOutcomeStats: OpOutcomeStats | null = null;

// Load lazily (not at module import) so a late LAX_DATA_DIR — and tests that set
// it after import — resolve to the right file. Seeded from disk on the first
// record after a (re)start so prior counts aren't clobbered.
function loadOpOutcomeStats(): OpOutcomeStats {
  if (opOutcomeStats) return opOutcomeStats;
  let loaded: OpOutcomeStats;
  try {
    const raw = JSON.parse(readFileSync(join(getLaxDir(), OP_OUTCOMES_FILE), "utf-8"));
    loaded = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    loaded = {};
  }
  opOutcomeStats = loaded;
  return loaded;
}

export function recordOpOutcome(category: OpCategory, outcome: OpOutcome, model: string | undefined): void {
  const stats = loadOpOutcomeStats();
  const key = `${category}::${model || "unknown"}`;
  const entry = (stats[key] ??= { total: 0, clean: 0, partial: 0, aborted: 0 });
  entry.total++;
  entry[outcome]++;
  const dir = getLaxDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, OP_OUTCOMES_FILE), JSON.stringify(stats, null, 2), "utf-8");
}

export function getOpOutcomeStats(): OpOutcomeStats {
  return { ...loadOpOutcomeStats() };
}

/** Test-only — drop the in-memory cache so the next read reloads from disk
 *  (exercises restart-survival). */
export function _resetOpOutcomeCache(): void {
  opOutcomeStats = null;
}
