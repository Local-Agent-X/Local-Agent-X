/**
 * Memory Dream Agent — periodic deep reflection over recent sessions.
 *
 * Inspired by Claude Code's autoDream: a background agent reviews recent
 * conversations and consolidates knowledge into durable memory files.
 *
 * Gates (cheapest first):
 *   1. Time: 24+ hours since last dream
 *   2. Sessions: 5+ sessions since last dream
 *   3. Lock: no other dream running
 *
 * The dream agent reads RAW session transcripts (not the lossy summaries
 * the previous version used) so detail-rich content survives extraction.
 * Long batches are split into ~20k-token windows so the LLM context never
 * blows up; dream emits incremental memory writes between batches and
 * later batches can see what earlier ones extracted (writes flow through
 * MemoryIndex → universal-index → searchable immediately).
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { extractSessionPairs, type ConversationMessage } from "./chunking.js";
import { getLaxDir } from "../lax-data-dir.js";
import { runMemoryGate } from "./write-safely.js";

import { createLogger } from "../logger.js";
const logger = createLogger("memory-dream");

const LAX_DIR = getLaxDir();
const MEMORY_DIR = join(LAX_DIR, "memory");
const SESSIONS_DIR = join(LAX_DIR, "sessions");
const DREAM_STATE_PATH = join(LAX_DIR, "dream-state.json");

// Default batch token budget. Conservative at 20k so the dream prompt +
// existing-memory context + assistant scratch space all fit comfortably
// inside a 128k window with room for tool I/O.
const DEFAULT_BATCH_TOKENS = 20_000;
// How many recent session JSONs the dream reads per cycle.
const DEFAULT_SESSION_COUNT = 10;

interface DreamState {
  lastDreamAt: number;
  lastDreamSessionCount: number;
  dreaming: boolean;
  dreamStartedAt?: number; // Track when dream started for crash recovery
}

function loadDreamState(): DreamState {
  try {
    if (existsSync(DREAM_STATE_PATH)) return JSON.parse(readFileSync(DREAM_STATE_PATH, "utf-8"));
  } catch {}
  return { lastDreamAt: 0, lastDreamSessionCount: 0, dreaming: false };
}

function saveDreamState(state: DreamState): void {
  const gated = runMemoryGate({
    content: JSON.stringify(state, null, 2),
    source: "tool",
    target: DREAM_STATE_PATH,
  });
  writeFileSync(DREAM_STATE_PATH, gated, "utf-8");
}

/** Count sessions modified since the last dream */
function countRecentSessions(since: number): number {
  if (!existsSync(SESSIONS_DIR)) return 0;
  try {
    return readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .filter((f) => {
        try { return statSync(join(SESSIONS_DIR, f)).mtimeMs > since; }
        catch { return false; }
      }).length;
  } catch { return 0; }
}

/**
 * Check if it's time to dream.
 *
 * Default thresholds (6h + 2 sessions) lowered from the original 24h + 5
 * sessions in May 2026 as Phase 4 of the memory restore. With Phase 1
 * (`<core_memory>` live render) and Phase 2 (same-turn auto-extract of
 * preferences/events) doing most of the work, dream is the long-tail
 * safety net — facts that fell through both should still get distilled
 * within hours, not days. The 30-minute stuck-lock recovery below means
 * a more frequent cadence doesn't risk pile-ups.
 */
export function shouldDream(minHours = 6, minSessions = 2): boolean {
  const state = loadDreamState();
  // Crash recovery: if dreaming flag is stuck for 30+ minutes, force-release it
  if (state.dreaming) {
    const stuckMinutes = (Date.now() - (state.dreamStartedAt || 0)) / 60_000;
    if (stuckMinutes > 30) {
      logger.warn(`[dream] Stuck lock detected (${Math.round(stuckMinutes)}m) — force-releasing`);
      state.dreaming = false;
      saveDreamState(state);
    } else {
      return false; // legitimately running
    }
  }
  const hoursSince = (Date.now() - state.lastDreamAt) / 3_600_000;
  if (hoursSince < minHours) return false;
  const sessions = countRecentSessions(state.lastDreamAt);
  return sessions >= minSessions;
}

// ── Raw transcript reading ───────────────────────────────────────────────

export interface SessionTranscript {
  sessionId: string;
  date: string | undefined;
  title: string | undefined;
  pairs: ConversationMessage[];
  approxTokens: number;
}

/**
 * List the N most recently-modified session JSONs and extract their
 * full message pairs. Replaces the old "first 500 chars of each
 * session summary" approach so detail-rich content survives.
 */
export function listRecentSessionTranscripts(n = DEFAULT_SESSION_COUNT): SessionTranscript[] {
  if (!existsSync(SESSIONS_DIR)) return [];

  const candidates = readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const fullPath = join(SESSIONS_DIR, f);
      try {
        const stat = statSync(fullPath);
        return { file: f, mtime: stat.mtimeMs };
      } catch { return null; }
    })
    .filter((x): x is { file: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, n);

  const out: SessionTranscript[] = [];
  for (const { file } of candidates) {
    const fullPath = join(SESSIONS_DIR, file);
    const sessionId = file.replace(/\.jsonl$/, "");
    let date: string | undefined;
    let title: string | undefined;
    try {
      // Read meta line from the jsonl file for date/title.
      for (const line of readFileSync(fullPath, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const row = JSON.parse(trimmed);
        if (row.kind === "meta") {
          if (typeof row.createdAt === "number") date = new Date(row.createdAt).toISOString().split("T")[0];
          if (typeof row.title === "string") title = row.title;
          break;
        }
      }
    } catch {}
    const pairs = extractSessionPairs(fullPath);
    if (pairs.length < 2) continue;
    const charCount = pairs.reduce((sum, m) => sum + m.content.length, 0);
    out.push({ sessionId, date, title, pairs, approxTokens: Math.ceil(charCount / 4) });
  }
  return out;
}

/**
 * Pack transcripts into batches that fit a token budget. Each batch
 * holds whole sessions (no mid-session splits) so the LLM always sees
 * coherent conversations. A single oversize session goes in a batch of
 * its own and may exceed the budget — that's fine, dream just gets a
 * larger window for that one batch.
 */
export function buildDreamBatches(
  transcripts: SessionTranscript[],
  maxTokensPerBatch = DEFAULT_BATCH_TOKENS,
): SessionTranscript[][] {
  const batches: SessionTranscript[][] = [];
  let current: SessionTranscript[] = [];
  let currentTokens = 0;

  for (const t of transcripts) {
    if (current.length > 0 && currentTokens + t.approxTokens > maxTokensPerBatch) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(t);
    currentTokens += t.approxTokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function formatTranscriptForPrompt(t: SessionTranscript): string {
  const header = `### Session ${t.sessionId}${t.date ? ` (${t.date})` : ""}${t.title ? ` — ${t.title}` : ""}`;
  const body = t.pairs
    .map((m) => `[${m.role}] ${m.content}`)
    .join("\n");
  return `${header}\n${body}`;
}

function listMemoryFilesSnapshot(): string[] {
  if (!existsSync(MEMORY_DIR)) return [];
  try {
    return readdirSync(MEMORY_DIR)
      .filter((f) => f.endsWith(".md"))
      .slice(0, 20);
  } catch { return []; }
}

/**
 * Build a per-batch dream prompt. The prompt tells the LLM:
 *   - what memory files already exist
 *   - which batch this is (so it can pace its writes across batches)
 *   - the full raw transcripts for this batch
 *   - how to write back into memory
 */
export function buildDreamPromptForBatch(
  batch: SessionTranscript[],
  batchIndex: number,
  totalBatches: number,
): string {
  const memFiles = listMemoryFilesSnapshot();
  const transcriptBlock = batch.map(formatTranscriptForPrompt).join("\n\n---\n\n");

  return `# Dream: Memory Consolidation (batch ${batchIndex + 1}/${totalBatches})

You are performing a dream — a reflective pass over recent raw conversations
to consolidate detail-rich knowledge into durable memory.

Memory directory: ${MEMORY_DIR}

## Phase 1 — Orient

Existing memory files:
${memFiles.length > 0 ? memFiles.map((f) => `- ${f}`).join("\n") : "- (no memory files yet)"}

If this is batch ${batchIndex + 1} of ${totalBatches}, earlier batches may
have already written to these files. Read them before deciding what to add.

## Phase 2 — Review Raw Transcripts

You have ${batch.length} session(s) in this batch. These are FULL transcripts,
not summaries — preserve the specifics (numbers, names, exact phrasings,
hardware decisions, design choices) that summaries normally lose.

${transcriptBlock}

## Phase 3 — Extract & Save

Use the available tools to:
- read existing memory files before overwriting
- write/edit memory files in ${MEMORY_DIR} with newly-learned facts
- use \`remember\` for durable facts (one sentence per call; tag entities with @-prefix)
- use \`update_fact\` to correct a fact already in memory; \`forget\` to mark one no longer true

What to extract:
- Concrete decisions ("camera goes in the bridge of the glasses, speakers at the temples")
- User preferences and feedback (corrections, validated approaches)
- Project context (deadlines, blockers, why X was chosen over Y)
- Hardware/tooling/software choices with specific reasons

What NOT to extract:
- Routine tool calls, debugging chatter, ephemeral state
- Anything already documented in the memory files above
- Chat-transcript snippets verbatim (extract the FACT, not the dialogue)

## Phase 4 — Output

End your turn with a one-line summary of what you saved. Files you write
become searchable immediately — later batches can see them.`;
}

/**
 * Single-batch fallback prompt — used when there are no raw transcripts
 * available (e.g., fresh install). Keeps the system functional without
 * requiring a special case in the runner.
 */
export function buildDreamPrompt(): string {
  const memFiles = listMemoryFilesSnapshot();
  return `# Dream: Memory Consolidation

You are performing a dream — but no recent raw session transcripts are
available. Review your existing memory files for inconsistencies,
duplicates, or stale entries instead.

Memory directory: ${MEMORY_DIR}

Existing memory files:
${memFiles.length > 0 ? memFiles.map((f) => `- ${f}`).join("\n") : "- (no memory files yet)"}

Tools: read, write, edit, memory_search, memory_save.

End with a one-line summary of what you cleaned up.`;
}

/** Mark dream as started */
export function startDream(): void {
  const state = loadDreamState();
  state.dreaming = true;
  state.dreamStartedAt = Date.now();
  saveDreamState(state);
}

/** Mark dream as completed */
export function completeDream(sessionCount: number): void {
  saveDreamState({
    lastDreamAt: Date.now(),
    lastDreamSessionCount: sessionCount,
    dreaming: false,
  });
  logger.info(`[dream] Consolidation complete. Reviewed ${sessionCount} sessions.`);
}

/** Mark dream as failed (reset lock) */
export function failDream(): void {
  const state = loadDreamState();
  state.dreaming = false;
  saveDreamState(state);
  logger.warn("[dream] Consolidation failed — lock released.");
}
