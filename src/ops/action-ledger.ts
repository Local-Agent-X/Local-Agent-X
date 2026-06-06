/**
 * Operational action ledger — the agent's persistent record of what it DID.
 *
 * op_turns already records each turn's tool calls + outcomes, but it's per-op
 * and the in-memory session→op map (session-bridge) drops ops on completion,
 * so there is no way to ask "what have I done across the last few messages of
 * this conversation?" once an op finishes. This ledger closes that gap: a
 * session-keyed, append-only log written once per committed turn (the single
 * write site is commitTurn). It is a denormalized read-index over op_turns'
 * {tool, status} summary — NOT a second source of truth.
 *
 * Readers (the situational-awareness digest, the read_my_logs tool, and the
 * fast-follow memory consolidation) consume this file; they never re-walk op
 * directories to reconstruct action history.
 *
 * Stored at ~/.lax/action-log/<session-slug>.jsonl. One file per session keeps
 * reads cheap (no global scan) and lets a session's history be dropped wholesale
 * if needed.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { createLogger } from "../logger.js";

const logger = createLogger("ops.action-ledger");

export type ActionStatus = "ok" | "error" | "cancelled";

export interface LedgerAction {
  tool: string;
  status: ActionStatus;
}

export interface ActionLedgerEntry {
  /** ISO timestamp of the committed turn. */
  ts: string;
  sessionId: string;
  opId: string;
  /** chat_turn | voice_turn | agent_turn | … — lets readers distinguish surfaces. */
  opType: string;
  turnIdx: number;
  /** The op's task / originating user message, clipped. Context for read_my_logs. */
  task?: string;
  actions: LedgerAction[];
  terminalReason: "done" | "error" | null;
}

const TASK_MAX_CHARS = 200;

function ledgerDir(): string {
  return join(getLaxDir(), "action-log");
}

// Session ids can contain path-hostile characters (uuids are fine, but voice
// uses "voice-<uuid>" and callers may pass arbitrary ids). Slug to a safe
// filename; collisions across distinct sessions are not a concern at this scope.
function ledgerPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "default";
  return join(ledgerDir(), `${safe}.jsonl`);
}

/**
 * Append one turn's action summary. No-op for turns with no tool calls (pure
 * conversational turns are noise here) or no session to scope to. Best-effort:
 * a write failure is logged, never thrown — the commit must not fail because
 * the ledger is unwritable.
 */
export function appendActionLedger(entry: ActionLedgerEntry): void {
  if (!entry.sessionId) return;
  if (entry.actions.length === 0) return;
  const clipped: ActionLedgerEntry = {
    ...entry,
    task: entry.task ? entry.task.replace(/\s+/g, " ").slice(0, TASK_MAX_CHARS) : undefined,
  };
  try {
    const path = ledgerPath(entry.sessionId);
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, JSON.stringify(clipped) + "\n", { encoding: "utf-8", mode: 0o600 });
  } catch (e) {
    logger.warn(`append failed sess=${entry.sessionId}: ${(e as Error).message}`);
  }
}

/**
 * Read a session's ledger, oldest→newest. `limit` keeps the most RECENT N
 * entries; `sinceTs` filters to entries at/after an ISO timestamp.
 */
export function readSessionActions(
  sessionId: string,
  opts: { limit?: number; sinceTs?: string } = {},
): ActionLedgerEntry[] {
  if (!sessionId) return [];
  const path = ledgerPath(sessionId);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf-8");
    const out: ActionLedgerEntry[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t) as ActionLedgerEntry;
        if (opts.sinceTs && e.ts < opts.sinceTs) continue;
        out.push(e);
      } catch { /* skip malformed line */ }
    }
    return opts.limit && opts.limit > 0 ? out.slice(-opts.limit) : out;
  } catch (e) {
    logger.warn(`read failed sess=${sessionId}: ${(e as Error).message}`);
    return [];
  }
}

/**
 * Flatten the most recent ledger entries into a single newest-last action list,
 * capped at `maxActions`. Convenience for the digest's one-line recent-actions
 * summary.
 */
export function recentActions(sessionId: string, maxActions: number): LedgerAction[] {
  const entries = readSessionActions(sessionId, { limit: maxActions });
  const flat: LedgerAction[] = [];
  for (const e of entries) {
    for (const a of e.actions) flat.push(a);
  }
  return flat.slice(-maxActions);
}
