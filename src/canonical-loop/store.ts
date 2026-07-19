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
 * approach as ops/event-log.ts.
 *
 * CL-9: the seq is assigned UNDER the same cross-process op lock (withOpLock)
 * that OP-9 uses for signal RMW, so two writers on one ~/.lax that are NOT in
 * the same process (the lease-holding worker AND control-api emitting
 * cancel/pause/redirect from a possibly-second server, plus recovery emitting
 * lease_lost) can never hand out the same seq. To avoid an O(n) full-file
 * rescan on every emit, a per-op in-memory cache holds the next seq keyed to
 * the file's byte size at our last append; any foreign append grows the file
 * (append-only ⇒ size strictly increases), so a size mismatch forces a
 * re-seed from disk under the lock — the hot single-writer path never
 * re-reads the file.
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { opDir } from "../ops/event-log.js";
import { withOpLock } from "../ops/op-store.js";
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
import {
  committedMessagesFromArtifact,
  readTurnArtifact,
} from "./turn-commit-store.js";

import { createLogger } from "../logger.js";
const logger = createLogger("canonical-loop.store");

// ── op_events — per-op monotonic seq, append-only ────────────────────────

/**
 * Compute the next `seq` for this op by reading the canonical event log from
 * disk. Uses line count to avoid full JSON parse. PRD §12: per-op monotonic,
 * no gaps. This is the authoritative (re)seed used under the op lock; the hot
 * path in `appendCanonicalEvent` short-circuits it with a size-validated
 * cache, so a full read only happens on the first emit in a process or after
 * a foreign writer appended.
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
 * Per-op seq cache: the next seq to assign, keyed to the file byte-size we
 * left the log at. Valid ONLY while the on-disk size still equals `size` —
 * any append by another writer (in this process or a second server on the
 * same ~/.lax) strictly grows an append-only file, so a mismatch means the
 * cache is stale and we must re-seed from disk. Reads/writes happen under
 * withOpLock, so the cache never lets two processes hand out the same seq.
 */
interface SeqCacheEntry { nextSeq: number; size: number; }
const seqCache = new Map<string, SeqCacheEntry>();

/** Test-only: drop the in-memory seq cache (simulate a fresh process). */
export function _resetSeqCache(): void {
  seqCache.clear();
}

/**
 * Append one canonical event to op_events. Returns the persisted row
 * including the assigned `seq`. Synchronous flush for ordering.
 *
 * The seq is computed and advanced UNDER withOpLock (CL-9): this makes the
 * seq authoritative across processes regardless of which writer emits (the
 * lease-holding worker, control-api on a second server, or recovery), so
 * callers do NOT need to already hold the lock — withOpLock is reentrant, so
 * a caller that does hold it pays no extra cost.
 */
export function appendCanonicalEvent(
  opId: string,
  type: CanonicalEventType,
  body: Record<string, unknown> | null = null,
): CanonicalEvent {
  return appendCanonicalEventWithMode(opId, type, body, false);
}

/** Commit-projection variant: persistence failure is recoverable work, not a
 * bus-only success, so it must surface to the envelope reconciler. */
export function appendCanonicalEventStrict(
  opId: string,
  type: CanonicalEventType,
  body: Record<string, unknown> | null = null,
): CanonicalEvent {
  return appendCanonicalEventWithMode(opId, type, body, true);
}

function appendCanonicalEventWithMode(
  opId: string,
  type: CanonicalEventType,
  body: Record<string, unknown> | null,
  strict: boolean,
): CanonicalEvent {
  // Ensure op dir exists (opDir() does mkdir).
  opDir(opId);
  const path = canonicalEventsPath(opId);
  return withOpLock(opId, () => {
    const currentSize = existsSync(path) ? statSync(path).size : 0;
    const cached = seqCache.get(opId);
    // Trust the cache only if the file is byte-for-byte what we left it as;
    // otherwise re-seed from disk (a foreign writer appended under the lock).
    const seq = cached && cached.size === currentSize ? cached.nextSeq : nextEventSeq(opId);
    const event: CanonicalEvent = {
      opId,
      seq,
      type,
      ts: new Date().toISOString(),
      body,
    };
    const line = JSON.stringify(event) + "\n";
    try {
      appendFileSync(path, line, { encoding: "utf-8", mode: 0o600 });
      // Advance the cache only on a durable append — a failed write must not
      // burn a seq that never landed on disk.
      seqCache.set(opId, { nextSeq: seq + 1, size: currentSize + Buffer.byteLength(line, "utf-8") });
    } catch (e) {
      logger.warn(`[store] failed to append canonical event for ${opId}: ${(e as Error).message}`);
      if (strict) throw e;
    }
    return event;
  });
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
 * Insert a new `op_turns` row. Returns false ONLY when `(op_id, turn_idx)`
 * already exists (the idempotent replay path — PRD §11). On a genuine write
 * failure (disk-full / EACCES / EISDIR) it THROWS rather than returning false:
 * a swallowed insert would leave `false` overloaded ("already committed" vs
 * "never landed"), letting commitTurn transition an op to `succeeded` with no
 * op_turns row on disk. Callers (commitTurn) let the throw propagate to the
 * worker's terminal-finalize catch, which closes the op as `failed`.
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
    // Do NOT collapse into `return false` — that is the "already exists"
    // signal. Log (preserved) and re-throw so the failure surfaces.
    logger.warn(`[store] insertOpTurn failed for ${row.opId}#${row.turnIdx}: ${(e as Error).message}`);
    throw e;
  }
}

/** Read the latest committed turn (highest turn_idx) or null if none. */
export function readLatestOpTurn(opId: string): OpTurnRow | null {
  const dir = opTurnsDir(opId);
  if (!existsSync(dir)) return null;
  try {
    const entries = readdirSync(dir).filter((f: string) => f.endsWith(".json"));
    if (entries.length === 0) return null;
    const idxs: number[] = [];
    for (const f of entries) {
      const n = parseInt(f.replace(/\.json$/, ""), 10);
      if (Number.isFinite(n) && n >= 0) idxs.push(n);
    }
    idxs.sort((a, b) => b - a);
    for (const turnIdx of idxs) {
      const row = readOpTurn(opId, turnIdx);
      if (row) return row;
    }
    return null;
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
  const artifact = readTurnArtifact(opId, turnIdx);
  if (!artifact) return null;
  return "turn" in artifact ? artifact.turn : artifact;
}

// ── op_messages — append-only ─────────────────────────────────────────────
//
// SEAL: op_messages rows are canonical-loop's internal turn metadata, not
// chat messages. External readers MUST consume rows through
// `opMessageRowToChatParam()` (canonical-loop/chat-runner) — it is the only
// shape adapter that maps a row to a `ChatCompletionMessageParam`. Reading
// the op_messages JSONL directly outside canonical-loop is forbidden: it
// bypasses the adapter and exposes internal turn metadata (hist- seeds,
// tool-call envelopes) in the wrong format. The two sanctioned external
// callers — canonical-run.ts:persistTurnState and bootstrap-bridges.ts —
// both call readOpMessages() then opMessageRowToChatParam() per row.

/**
 * Append one op_messages row. THROWS on a genuine write failure (disk-full /
 * EACCES / EISDIR) instead of swallowing it: a silently-dropped message would
 * let commitTurn report the turn as `succeeded` while a message is missing on
 * disk (transcript hole). The throw propagates to the worker's terminal
 * catch, which finalizes the op as `failed` rather than lying about success.
 */
export function appendOpMessage(row: OpMessageRow): void {
  const path = opMessagesPath(row.opId);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const line = JSON.stringify(row) + "\n";
  try {
    appendFileSync(path, line, { encoding: "utf-8", mode: 0o600 });
  } catch (e) {
    // Log (preserved) then re-throw so the failed write surfaces to the
    // commit boundary — never swallow it into a false success.
    logger.warn(`[store] appendOpMessage failed for ${row.opId}: ${(e as Error).message}`);
    throw e;
  }
}

/**
 * Text of the op's FIRST user message — the original task request. The one
 * source for every prompter/gate that anchors to "what the user asked for"
 * (spec-probes, spec-audit, situational-awareness). Non-text content → "".
 */
export function firstUserMessageText(opId: string): string {
  const first = readOpMessages(opId).find((m) => m.role === "user");
  if (!first) return "";
  const c = first.content;
  if (typeof c === "string") return c;
  if (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string") {
    return (c as { text: string }).text;
  }
  return "";
}

/**
 * Texts of every redirect instruction APPLIED during the op, in application
 * order. The redirect column is one-slot and cleared on consume, and the
 * `[REDIRECT]` prompt row is transport-only, so the `redirect_applied` event
 * body (checkpoint.ts) is the sole durable record. Amendments to the request
 * arrive this way mid-op; spec-audit folds them into the done-claim audit so
 * "what the user asked for" means the WHOLE ask, not just the first message.
 * Events predating the `text` field are skipped — absent evidence, not "".
 */
export function appliedRedirectTexts(opId: string): string[] {
  const out: string[] = [];
  for (const e of readCanonicalEvents(opId)) {
    if (e.type !== "redirect_applied") continue;
    const text = (e.body as { text?: unknown } | null)?.text;
    if (typeof text === "string" && text.trim()) out.push(text.trim());
  }
  return out;
}

export function readOpMessages(opId: string): OpMessageRow[] {
  const path = opMessagesPath(opId);
  const byId = new Map<string, OpMessageRow>();
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf-8");
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const row = JSON.parse(t) as OpMessageRow;
          byId.set(row.messageId, row);
        } catch {
          logger.warn(`[store] skipped unparseable op-message line for ${opId}`);
        }
      }
    }
    const dir = opTurnsDir(opId);
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        const match = /^(\d+)\.json$/.exec(name);
        if (!match) continue;
        const artifact = readTurnArtifact(opId, Number(match[1]));
        for (const row of committedMessagesFromArtifact(artifact)) byId.set(row.messageId, row);
      }
    }
    return [...byId.values()].sort((a, b) =>
      a.turnIdx - b.turnIdx || a.seqInTurn - b.seqInTurn || a.messageId.localeCompare(b.messageId));
  } catch (e) {
    logger.warn(`[store] readOpMessages failed for ${opId}: ${(e as Error).message}`);
    return [];
  }
}
