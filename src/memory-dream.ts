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
 * The dream agent runs as a real LLM call (not just code) so it can
 * reason about what's important and how to organize it.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SAX_DIR = join(homedir(), ".sax");
const MEMORY_DIR = join(SAX_DIR, "memory");
const SESSIONS_DIR = join(SAX_DIR, "sessions");
const DREAM_STATE_PATH = join(SAX_DIR, "dream-state.json");

interface DreamState {
  lastDreamAt: number;
  lastDreamSessionCount: number;
  dreaming: boolean;
}

function loadDreamState(): DreamState {
  try {
    if (existsSync(DREAM_STATE_PATH)) return JSON.parse(readFileSync(DREAM_STATE_PATH, "utf-8"));
  } catch {}
  return { lastDreamAt: 0, lastDreamSessionCount: 0, dreaming: false };
}

function saveDreamState(state: DreamState): void {
  writeFileSync(DREAM_STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

/** Count sessions modified since the last dream */
function countRecentSessions(since: number): number {
  if (!existsSync(SESSIONS_DIR)) return 0;
  try {
    return readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(".json"))
      .filter((f) => {
        try { return statSync(join(SESSIONS_DIR, f)).mtimeMs > since; }
        catch { return false; }
      }).length;
  } catch { return 0; }
}

/** Check if it's time to dream */
export function shouldDream(minHours = 24, minSessions = 5): boolean {
  const state = loadDreamState();
  if (state.dreaming) return false; // already running
  const hoursSince = (Date.now() - state.lastDreamAt) / 3_600_000;
  if (hoursSince < minHours) return false;
  const sessions = countRecentSessions(state.lastDreamAt);
  return sessions >= minSessions;
}

/** Build the dream prompt — tells the LLM how to consolidate memories */
export function buildDreamPrompt(): string {
  const memFiles = existsSync(MEMORY_DIR) ? readdirSync(MEMORY_DIR).filter((f) => f.endsWith(".md")).slice(0, 20) : [];
  const summaryDir = join(MEMORY_DIR, "session-summaries");
  const recentSummaries = existsSync(summaryDir)
    ? readdirSync(summaryDir).filter((f) => f.endsWith(".md")).sort().slice(-10)
    : [];

  const summaryContent = recentSummaries.map((f) => {
    try { return readFileSync(join(summaryDir, f), "utf-8").slice(0, 500); }
    catch { return ""; }
  }).filter(Boolean).join("\n---\n");

  return `# Dream: Memory Consolidation

You are performing a dream — a reflective pass over your memory files and recent sessions. Your goal is to synthesize what you've learned into durable, well-organized memories.

Memory directory: ${MEMORY_DIR}

## Phase 1 — Orient

Read the current memory files to understand what already exists:
${memFiles.length > 0 ? memFiles.map((f) => `- ${f}`).join("\n") : "- (no memory files yet)"}

## Phase 2 — Review Recent Sessions

${recentSummaries.length > 0 ? `Recent session summaries (${recentSummaries.length}):\n\n${summaryContent}` : "No recent session summaries available."}

Review what happened in recent conversations. Look for:
- New facts about the user (preferences, role, projects)
- Feedback the user gave (corrections, confirmations)
- Project context that would help in future sessions
- Patterns in tool usage or common workflows

## Phase 3 — Consolidate

For each thing worth remembering:
1. Check if it's already in an existing memory file — update rather than duplicate
2. Convert relative dates ("yesterday", "last week") to absolute dates
3. Delete or correct contradicted facts
4. Merge related small facts into coherent topic files

Use these tools:
- read: to examine existing memory files
- write: to create or update memory files in ${MEMORY_DIR}
- edit: to modify existing memory files

Memory file format:
\`\`\`markdown
# Topic Name

Key facts about this topic, organized clearly.
Updated: YYYY-MM-DD
\`\`\`

## Phase 4 — Prune

- Remove memories that are stale, wrong, or superseded
- Keep the total number of memory files manageable (under 30)
- Each file should be focused on one topic

## Important Rules

- DO NOT create memories about debugging sessions or temporary issues
- DO NOT duplicate what's already in memory
- FOCUS on user preferences, project context, and learned patterns
- Be concise — each memory file should be under 50 lines
- End with a brief summary of what you consolidated

Return a summary of what changed.`;
}

/** Mark dream as started */
export function startDream(): void {
  const state = loadDreamState();
  state.dreaming = true;
  saveDreamState(state);
}

/** Mark dream as completed */
export function completeDream(sessionCount: number): void {
  saveDreamState({
    lastDreamAt: Date.now(),
    lastDreamSessionCount: sessionCount,
    dreaming: false,
  });
  console.log(`[dream] Consolidation complete. Reviewed ${sessionCount} sessions.`);
}

/** Mark dream as failed (reset lock) */
export function failDream(): void {
  const state = loadDreamState();
  state.dreaming = false;
  saveDreamState(state);
  console.warn("[dream] Consolidation failed — lock released.");
}
