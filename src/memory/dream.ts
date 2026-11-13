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
import { getLaxDir } from "../lax-data-dir.js";
import { countUnreviewedSessions, readUnreviewedSessions, withReviewed, type ReviewMarks, type SessionTranscript } from "./dream-review-marks.js";
export type { SessionTranscript } from "./dream-review-marks.js";
import { runMemoryGate } from "./write-safely.js";
import { createLogger } from "../logger.js";
import { createInternalMemoryContext } from "./promotion-gate.js";
const logger = createLogger("memory-dream");

const LAX_DIR = getLaxDir();
const MEMORY_DIR = join(LAX_DIR, "memory");
const SESSIONS_DIR = join(LAX_DIR, "sessions");
const DREAM_STATE_PATH = join(LAX_DIR, "dream-state.json");

// Default batch token budget. Conservative at 20k so the dream prompt +
// existing-memory context + assistant scratch space all fit comfortably
// inside a 128k window with room for tool I/O.
const DEFAULT_BATCH_TOKENS = 20_000;
const DEFAULT_SESSION_COUNT = 10; // recent session JSONs read per cycle
// Hard cap on batches per dream cycle. Each batch spawns its own worker
// card in the AGENTS sidebar, so an uncapped pack over 10 sessions could
// fan out into 5+ cards. Clamping to 3 keeps the sidebar legible; when the
// token-budget pack would exceed this, sessions are redistributed into
// exactly this many (larger) windows so none are dropped — haiku's window
// has ample room above the conservative 20k budget.
const MAX_DREAM_BATCHES = 3;

interface DreamState {
  lastDreamAt: number;
  lastDreamSessionCount: number;
  dreaming: boolean;
  dreamStartedAt?: number; // Track when dream started for crash recovery
  /** How far finished dreams have read each session (dream-review-marks.ts). */
  reviewed?: ReviewMarks;
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
    promotion: createInternalMemoryContext(JSON.stringify(state, null, 2), DREAM_STATE_PATH, "dream-state"),
  });
  writeFileSync(DREAM_STATE_PATH, gated, "utf-8");
}

/** Sessions no finished dream has read since they last changed. */
function countUnreadSessions(state: DreamState): number {
  if (!existsSync(SESSIONS_DIR)) return 0;
  try { return countUnreviewedSessions(SESSIONS_DIR, loadReviewMarks(state)); }
  catch { return 0; } // sessions dir unreadable: nothing to dream about
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
  return countUnreadSessions(state) >= minSessions;
}

// ── Raw transcript reading ───────────────────────────────────────────────

/** What finished dreams have read. Before marks existed, the sessions changed
 *  up to the last dream count as read: those dreams sent them. */
function loadReviewMarks(state: DreamState = loadDreamState()): ReviewMarks {
  return state.reviewed ?? { from: state.lastDreamAt, sessions: {} };
}

/**
 * Up to N sessions with messages no finished dream has read, most recently
 * changed first, each with only those messages (full, not summaries, so
 * detail survives) and a few already-read ones before them as context.
 */
export function listRecentSessionTranscripts(n = DEFAULT_SESSION_COUNT): SessionTranscript[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  return readUnreviewedSessions(SESSIONS_DIR, loadReviewMarks(), n);
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
  maxBatches = MAX_DREAM_BATCHES,
): SessionTranscript[][] {
  // Raise the per-batch budget if the conservative default would fan out
  // past maxBatches, so sessions stay balanced across the allowed windows
  // rather than dumping the remainder into one oversized tail batch. The
  // post-pack fold below is what actually guarantees the ceiling.
  const totalTokens = transcripts.reduce((sum, t) => sum + t.approxTokens, 0);
  const budget = Math.max(maxTokensPerBatch, Math.ceil(totalTokens / maxBatches));

  const batches: SessionTranscript[][] = [];
  let current: SessionTranscript[] = [];
  let currentTokens = 0;

  for (const t of transcripts) {
    if (current.length > 0 && currentTokens + t.approxTokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(t);
    currentTokens += t.approxTokens;
  }
  if (current.length > 0) batches.push(current);

  // Greedy whole-session packing can spill one batch past maxBatches when
  // the widened budget leaves no slack. Fold any overflow into the last
  // allowed batch so the cap is a true ceiling on worker cards — never
  // dropping a session, just accepting a larger final window.
  if (batches.length > maxBatches) {
    const overflow = batches.splice(maxBatches - 1);
    batches.push(overflow.flat());
  }
  return batches;
}

export function formatTranscriptForPrompt(t: SessionTranscript): string {
  const header = `### Session ${t.sessionId}${t.date ? ` (${t.date})` : ""}${t.title ? ` — ${t.title}` : ""}`;
  const lines = (messages: SessionTranscript["pairs"]) => messages.map((m) => `[${m.role}] ${m.content}`).join("\n");
  if (t.earlier.length === 0) return `${header}\n${lines(t.pairs)}`;
  return `${header}\n#### Earlier (already reviewed by a past dream: context only, save nothing from it)\n${lines(t.earlier)}\n#### New since the last dream\n${lines(t.pairs)}`;
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

You have ${batch.length} session(s) in this batch. These are the FULL messages
said since the last dream, not summaries — preserve the specifics (numbers,
names, exact phrasings, hardware decisions, design choices) that summaries
normally lose. A section marked "Earlier (already reviewed …)" was read by a
past dream and is there only so the new messages make sense: save nothing from
it, and before saving anything search memory, since a past dream may have
saved it in other words.

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

Epistemic rules (mandatory):
- A durable fact must be supported by a direct User statement in these transcripts.
- Assistant statements, summaries, recommendations, guesses, and earlier memory are NOT evidence. Do not save them
  as facts unless independently supported by a direct User statement.
- Tool observations, external content, imports, and assistant paraphrases require interactive user approval before
  durable promotion. A background dream cannot grant that approval; leave them in their original provenance lane.
- Preserve modality exactly: "recommended", "proposed", "might", and "should" must never become "implemented",
  "enforced", "is", "did", or "permanent".
- Model-declared provenance is not evidence. Use \`user_statement\` only when the transcript directly supports it.
- Current runtime, security, policy, permission, service, session, and build state is ephemeral. Do not put it in
  durable memory. Operational outcomes belong in the action/audit ledger.

What NOT to extract:
- Routine tool calls, debugging chatter, ephemeral state
- Anything already documented in the memory files above
- Chat-transcript snippets verbatim (extract the FACT, not the dialogue)
- Claims whose only source is an Assistant line or another memory file

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

/** Mark dream as completed, recording how far it read each session it was sent.
 *  Only a finished dream records: a failed one's sessions are sent again. */
export function completeDream(sessionCount: number, read: SessionTranscript[] = []): void {
  const state = loadDreamState();
  saveDreamState({
    lastDreamAt: Date.now(),
    lastDreamSessionCount: sessionCount,
    dreaming: false,
    reviewed: withReviewed(loadReviewMarks(state), read),
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

// ── On-demand trigger seam ───────────────────────────────────────────────
//
// The agentic dream needs heavy server deps (security, toolPolicy, the agent
// tool catalog, session IO) that only exist at server bootstrap — tools and
// routes can't hold them. Mirroring registerWorkerRunner: the server registers
// the dream runner once (deps captured in a closure), and any caller triggers
// it through the deps-free triggerDream(). The registered runner is the ONLY
// code permitted to touch the dream-state lock (shouldDream/startDream/
// completeDream) — keeping a single owner and killing the historical
// "stamp lastDreamAt without running" sabotage.

export interface DreamRunResult {
  /** Whether the agentic dream actually ran (false = gated/no-op). */
  ran: boolean;
  /** Why it didn't run, when ran is false (e.g. "gated", "already running"). */
  reason?: string;
  batches: number;
  sessionsReviewed: number;
}

export type DreamRunner = (opts: { force?: boolean }) => Promise<DreamRunResult>;

let registeredDreamRunner: DreamRunner | null = null;

/** Wire the agentic dream at server startup. See registerDreamRunnerForServer. */
export function registerDreamRunner(runner: DreamRunner): void {
  registeredDreamRunner = runner;
}

/**
 * Run the agentic dream on demand. `force` bypasses the shouldDream() time
 * gate (used by the manual route/tool). Returns null when no runner is wired
 * (e.g. headless contexts that never started background jobs).
 */
export async function triggerDream(opts: { force?: boolean } = {}): Promise<DreamRunResult | null> {
  if (!registeredDreamRunner) return null;
  return registeredDreamRunner(opts);
}
