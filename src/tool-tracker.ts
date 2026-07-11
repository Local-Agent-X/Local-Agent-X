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
const STATS_FILE = "tool-stats.json";
const OP_OUTCOMES_FILE = "op-outcomes.json";

// ── Op-outcome telemetry (per category × model) ──
// tool-stats answers "does this tool work?". This answers "do we finish
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
	["coding", ["write", "edit", "edit_lines", "multi_edit", "bulk_replace", "bash", "build_app", "delete_file"]],
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

interface OpOutcomeEntry { total: number; clean: number; partial: number; aborted: number; gaveUpNudged?: number; }
/** Keyed by `${category}::${model}`. Counts are additive, so seeding from the
 *  on-disk aggregate and incrementing in memory survives restarts cleanly — the
 *  app restarts constantly (OTA, quit/reopen), and without this every restart
 *  reset the file to the current session. */
type OpOutcomeStats = Record<string, OpOutcomeEntry>;

export interface ToolTrackerOptions {
	/** Data dir override. Omitted → getLaxDir(), resolved lazily on first use
	 *  (NOT at construction), so a late LAX_DATA_DIR still lands right. */
	dir?: string;
}

export interface ToolTracker {
	recordToolCall(name: string, sessionId: string, success: boolean, durationMs: number, error?: string): void;
	getToolStats(): ToolStats;
	getToolSuccessRate(toolName?: string): number;
	getRecentFailures(limit?: number): ToolCallRecord[];
	loadPersistedStats(): ToolStats | null;
	recordOpOutcome(category: OpCategory, outcome: OpOutcome, model: string | undefined): void;
	recordGaveUpNudge(category: OpCategory, model: string | undefined): void;
	getOpOutcomeStats(): OpOutcomeStats;
	/** Test-only — drop the in-memory op-outcome cache so the next read reloads
	 *  from disk (exercises restart-survival). */
	_resetOpOutcomeCache(): void;
}

/**
 * Instance factory. All mutable state — the in-memory call records, the
 * op-outcome cache, and the resolved data dir — lives per instance, so tests
 * can create isolated trackers with their own dirs instead of sharing the
 * process-global default.
 */
export function createToolTracker(opts: ToolTrackerOptions = {}): ToolTracker {
	const records: ToolCallRecord[] = [];
	let opOutcomeStats: OpOutcomeStats | null = null;
	// Resolved lazily on first use, then pinned for the instance's lifetime so
	// stats and their persisted file can't drift apart mid-session.
	let dir: string | null = opts.dir ?? null;

	function resolveDir(): string {
		return (dir ??= getLaxDir());
	}

	function ensureDir(): string {
		const d = resolveDir();
		if (!existsSync(d)) {
			mkdirSync(d, { recursive: true });
		}
		return d;
	}

	function getToolStats(): ToolStats {
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

	function persistSummary(): void {
		const d = ensureDir();
		writeFileSync(join(d, STATS_FILE), JSON.stringify(getToolStats(), null, 2), "utf-8");
	}

	// Load lazily (not at construction) so a late LAX_DATA_DIR — and tests that
	// set it after import — resolve to the right file. Seeded from disk on the
	// first record after a (re)start so prior counts aren't clobbered.
	function loadOpOutcomeStats(): OpOutcomeStats {
		if (opOutcomeStats) return opOutcomeStats;
		let loaded: OpOutcomeStats;
		try {
			const raw = JSON.parse(readFileSync(join(resolveDir(), OP_OUTCOMES_FILE), "utf-8"));
			loaded = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
		} catch {
			loaded = {};
		}
		opOutcomeStats = loaded;
		return loaded;
	}

	function persistOpOutcomes(stats: OpOutcomeStats): void {
		const d = ensureDir();
		writeFileSync(join(d, OP_OUTCOMES_FILE), JSON.stringify(stats, null, 2), "utf-8");
	}

	return {
		recordToolCall(name, sessionId, success, durationMs, error) {
			records.push({ name, sessionId, timestamp: Date.now(), durationMs, success, error });
			if (records.length > MAX_ENTRIES) {
				records.splice(0, records.length - MAX_ENTRIES);
			}
			persistSummary();
		},

		getToolStats,

		getToolSuccessRate(toolName) {
			const filtered = toolName ? records.filter((r) => r.name === toolName) : records;
			if (filtered.length === 0) return 1;
			const successes = filtered.filter((r) => r.success).length;
			return successes / filtered.length;
		},

		getRecentFailures(limit = 10) {
			return records
				.filter((r) => !r.success)
				.slice(-limit);
		},

		loadPersistedStats() {
			try {
				const file = join(resolveDir(), STATS_FILE);
				if (existsSync(file)) {
					return JSON.parse(readFileSync(file, "utf-8"));
				}
			} catch {
				// ignore corrupted file
			}
			return null;
		},

		recordOpOutcome(category, outcome, model) {
			const stats = loadOpOutcomeStats();
			const key = `${category}::${model || "unknown"}`;
			const entry = (stats[key] ??= { total: 0, clean: 0, partial: 0, aborted: 0 });
			entry.total++;
			entry[outcome]++;
			persistOpOutcomes(stats);
		},

		// Count a give-up / hand-off nudge the loop fired mid-op (browser-handoff).
		// Separate from recordOpOutcome — the nudge fires DURING the op, not at the
		// terminal outcome — so it bumps only `gaveUpNudged`, never `total`. Same
		// additive-on-disk aggregate, so the per-model give-up rate survives restarts.
		recordGaveUpNudge(category, model) {
			const stats = loadOpOutcomeStats();
			const key = `${category}::${model || "unknown"}`;
			const entry = (stats[key] ??= { total: 0, clean: 0, partial: 0, aborted: 0 });
			entry.gaveUpNudged = (entry.gaveUpNudged ?? 0) + 1;
			persistOpOutcomes(stats);
		},

		getOpOutcomeStats() {
			return { ...loadOpOutcomeStats() };
		},

		_resetOpOutcomeCache() {
			opOutcomeStats = null;
		},
	};
}

// ── Default instance + thin wrappers ──
// Created lazily on FIRST USE, never at import, so importing this module binds
// neither the data dir nor any state. Existing call sites keep working
// unchanged through these wrappers.

let defaultTracker: ToolTracker | null = null;

function getDefaultTracker(): ToolTracker {
	return (defaultTracker ??= createToolTracker());
}

export function recordToolCall(
	name: string,
	sessionId: string,
	success: boolean,
	durationMs: number,
	error?: string,
): void {
	getDefaultTracker().recordToolCall(name, sessionId, success, durationMs, error);
}

export function getToolStats(): ToolStats {
	return getDefaultTracker().getToolStats();
}

export function getToolSuccessRate(toolName?: string): number {
	return getDefaultTracker().getToolSuccessRate(toolName);
}

export function getRecentFailures(limit: number = 10): ToolCallRecord[] {
	return getDefaultTracker().getRecentFailures(limit);
}

export function loadPersistedStats(): ToolStats | null {
	return getDefaultTracker().loadPersistedStats();
}

export function recordOpOutcome(category: OpCategory, outcome: OpOutcome, model: string | undefined): void {
	getDefaultTracker().recordOpOutcome(category, outcome, model);
}

export function recordGaveUpNudge(category: OpCategory, model: string | undefined): void {
	getDefaultTracker().recordGaveUpNudge(category, model);
}

export function getOpOutcomeStats(): OpOutcomeStats {
	return getDefaultTracker().getOpOutcomeStats();
}

/** Test-only — drop the default instance's op-outcome cache so the next read
 *  reloads from disk (exercises restart-survival). */
export function _resetOpOutcomeCache(): void {
	getDefaultTracker()._resetOpOutcomeCache();
}
