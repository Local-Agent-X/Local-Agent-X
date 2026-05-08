/**
 * Append-only writers/readers for the canonical-loop "tables" (PRD §9, §12).
 *
 * Issue 01 scope: the writers/readers exist and the canonical event log is
 * exercised by `canonical_loop_entry`. op_turns and op_messages writers are
 * provided so the schema is complete; they are not yet called by the loop
 * (Issue 03 lights them up).
 *
 * Atomicity in v1 is best-effort filesystem semantics: per-op `seq` is
 * derived from the current line count of canonical-events.jsonl, and
 * `appendCanonicalEvent` is synchronous to preserve ordering — same
 * approach as workers/event-log.ts.
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { opDir } from "../workers/event-log.js";
import {
  canonicalEventsPath,
  opMessagesPath,
  opTurnPath,
  opTurnsDir,
} from "./schema.js";
import type {
  CanonicalEvent,
  CanonicalEventType,
  OpMessageRow,
  OpTurnRow,
} from "./types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("canonical-loop.store");

// ── op_events — per-op monotonic seq, append-only ────────────────────────

/**
 * Compute the next `seq` for this op by reading the canonical event log.
 * Uses line count to avoid full JSON parse. PRD §12: per-op monotonic, no
 * gaps. Caller must hold the op's write authority (lease).
 */
export function nextEventSeq(opId: string): number {
  const path = canonicalEventsPath(opId);
  if (!existsSync(path)) return 0;
  try {
    const raw = readFileSync(path, "utf-8");
    let seq = 0;
    for (const line of raw.split("\n")) {
      if (line.trim().length > 0) seq++;
    }
    return seq;
  } catch (e) {
    logger.warn(`[store] failed to read canonical events for ${opId}: ${(e as Error).message}`);
    return 0;
  }
}

/**
 * Append one canonical event to op_events. Returns the persisted row
 * including the assigned `seq`. Synchronous flush for ordering.
 */
export function appendCanonicalEvent(
  opId: string,
  type: CanonicalEventType,
  body: Record<string, unknown> | null = null,
): CanonicalEvent {
  // Ensure op dir exists (opDir() does mkdir).
  opDir(opId);
  const seq = nextEventSeq(opId);
  const event: CanonicalEvent = {
    opId,
    seq,
    type,
    ts: new Date().toISOString(),
    body,
  };
  const line = JSON.stringify(event) + "\n";
  try {
    appendFileSync(canonicalEventsPath(opId), line, { encoding: "utf-8", mode: 0o600 });
  } catch (e) {
    logger.warn(`[store] failed to append canonical event for ${opId}: ${(e as Error).message}`);
  }
  return event;
}

/** Read all canonical events for an op, in seq order. */
export function readCanonicalEvents(opId: string): CanonicalEvent[] {
  const path = canonicalEventsPath(opId);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf-8");
    const out: CanonicalEvent[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as CanonicalEvent);
      } catch {
        logger.warn(`[store] skipped unparseable canonical-event line for ${opId}`);
      }
    }
    return out;
  } catch (e) {
    logger.warn(`[store] failed to read canonical events for ${opId}: ${(e as Error).message}`);
    return [];
  }
}

/**
 * `op_events_since` skeleton — Issue 04 lands the public API; the underlying
 * read primitive lives here so the storage layer is complete in Issue 01.
 */
export function readCanonicalEventsSince(opId: string, seq: number): CanonicalEvent[] {
  return readCanonicalEvents(opId).filter(e => e.seq > seq);
}

// ── op_turns — append-only, PK (op_id, turn_idx) ─────────────────────────

/**
 * Insert a new `op_turns` row. Returns false if `(op_id, turn_idx)` already
 * exists (idempotent replay path — PRD §11). Otherwise writes the row and
 * returns true.
 */
export function insertOpTurn(row: OpTurnRow): boolean {
  const path = opTurnPath(row.opId, row.turnIdx);
  if (existsSync(path)) return false;
  const dir = opTurnsDir(row.opId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(row, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch (e) {
    logger.warn(`[store] insertOpTurn failed for ${row.opId}#${row.turnIdx}: ${(e as Error).message}`);
    return false;
  }
}

/** Read the latest committed turn (highest turn_idx) or null if none. */
export function readLatestOpTurn(opId: string): OpTurnRow | null {
  const dir = opTurnsDir(opId);
  if (!existsSync(dir)) return null;
  try {
    const entries = readdirSync(dir).filter((f: string) => f.endsWith(".json"));
    if (entries.length === 0) return null;
    let bestIdx = -1;
    for (const f of entries) {
      const n = parseInt(f.replace(/\.json$/, ""), 10);
      if (Number.isFinite(n) && n > bestIdx) bestIdx = n;
    }
    if (bestIdx < 0) return null;
    return readOpTurn(opId, bestIdx);
  } catch (e) {
    logger.warn(`[store] readLatestOpTurn failed for ${opId}: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Read all op_turns for an op, ascending by turn_idx. Used by soak
 * telemetry to aggregate per-turn fields (modelMs, toolDispatchMs, tool
 * names) across the full op lifetime — readLatestOpTurn alone misses
 * the rounds that happened earlier in a multi-turn op.
 */
export function readOpTurns(opId: string): OpTurnRow[] {
  const dir = opTurnsDir(opId);
  if (!existsSync(dir)) return [];
  try {
    const entries = readdirSync(dir).filter((f: string) => f.endsWith(".json"));
    const idxs: number[] = [];
    for (const f of entries) {
      const n = parseInt(f.replace(/\.json$/, ""), 10);
      if (Number.isFinite(n) && n >= 0) idxs.push(n);
    }
    idxs.sort((a, b) => a - b);
    const rows: OpTurnRow[] = [];
    for (const i of idxs) {
      const r = readOpTurn(opId, i);
      if (r) rows.push(r);
    }
    return rows;
  } catch (e) {
    logger.warn(`[store] readOpTurns failed for ${opId}: ${(e as Error).message}`);
    return [];
  }
}

export function readOpTurn(opId: string, turnIdx: number): OpTurnRow | null {
  const path = opTurnPath(opId, turnIdx);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as OpTurnRow;
  } catch (e) {
    logger.warn(`[store] readOpTurn failed for ${opId}#${turnIdx}: ${(e as Error).message}`);
    return null;
  }
}

// ── op_messages — append-only ─────────────────────────────────────────────

export function appendOpMessage(row: OpMessageRow): void {
  const path = opMessagesPath(row.opId);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const line = JSON.stringify(row) + "\n";
  try {
    appendFileSync(path, line, { encoding: "utf-8", mode: 0o600 });
  } catch (e) {
    logger.warn(`[store] appendOpMessage failed for ${row.opId}: ${(e as Error).message}`);
  }
}

export function readOpMessages(opId: string): OpMessageRow[] {
  const path = opMessagesPath(opId);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf-8");
    const out: OpMessageRow[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as OpMessageRow);
      } catch {
        logger.warn(`[store] skipped unparseable op-message line for ${opId}`);
      }
    }
    return out;
  } catch (e) {
    logger.warn(`[store] readOpMessages failed for ${opId}: ${(e as Error).message}`);
    return [];
  }
}
