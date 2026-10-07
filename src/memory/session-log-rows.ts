/**
 * The one reader of the session log format (`~/.lax/sessions/{id}.jsonl`):
 * the row types and the line parse every consumer projects from. The
 * session store (readSessionLog), the indexers (extractSessionPairs, the
 * session-message counter) and the consolidation pass each used to split and
 * parse the file their own way, and each derived "the session's date" for
 * itself — so a fix to how a session is dated had to be made four times.
 * They now all read rows here. Leaf module: no local imports beyond types.
 */
import { readFileSync } from "node:fs";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

export interface SessionMetaRow {
  kind: "meta";
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  projectId?: string;
}

export interface SessionMessageRow {
  kind: "msg";
  /** Stable identity: the op store's messageId when the message came from a
   *  chat turn's op, else minted once by the writer (session-message-provenance).
   *  Absent only on rows written before 2026-10-07 and not yet rewritten. */
  id?: string;
  message: ChatCompletionMessageParam;
  createdAt: string;
  /** Set when the true time is not known: the row was re-stamped by a save
   *  before 2026-10-07 and no op record recovered it (session-time-backfill).
   *  createdAt then says when the row was last written, not when it was said. */
  timeUnknown?: true;
}

/**
 * Compaction event. A `summary` row subsumes every `msg` row that
 * appears BEFORE it in the file — the projection drops those msg rows
 * and prepends a synthetic leading `{role:"system", content: <summary>}`
 * entry. Only `msg` rows that appear AFTER the latest summary survive
 * verbatim. Multiple summary rows can stack (e.g. compact, run for a
 * while, compact again) — the latest summary is the active one.
 */
export interface SessionSummaryRow {
  kind: "summary";
  content: string;
  createdAt: string;
}

/**
 * Compaction CHECKPOINT — deliberately NOT a `summary` row.
 *
 * A summary row SUBSUMES everything before it: the read path drops those msg
 * rows entirely, which is right for the user-invoked /api/compact ("forget the
 * details, keep the gist") and catastrophic for automatic compaction, where the
 * harness would be deleting the user's transcript from disk to save tokens on a
 * request.
 *
 * A checkpoint subsumes nothing. Every msg row stays on disk and in the
 * projection; the row only records that the MODEL's view of the first
 * `coversThrough` messages may be sent as `summary` instead. The transcript
 * stays whole for the chat, fork, export, search and recall; only the request
 * gets shorter. It is also what makes a request prefix stable: recomputing a
 * summary every message reshuffles the prefix and voids the provider cache.
 *
 * `coversThrough` is a COUNT of projected messages, not an index into the
 * file: a retract can shorten the transcript, and a checkpoint that reaches
 * past the end is ignored rather than trusted (readSessionLog).
 */
export interface SessionCheckpointRow {
  kind: "checkpoint";
  summary: string;
  coversThrough: number;
  createdAt: string;
}

export type SessionLogRow = SessionMetaRow | SessionMessageRow | SessionSummaryRow | SessionCheckpointRow;

/** Every well-formed row of a session log, in file order; a torn or
 *  unparseable line is skipped. Null when the file cannot be read. */
export function readSessionLogRows(path: string): SessionLogRow[] | null {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  return parseSessionLogText(content).map((r) => r.row);
}

/** A session log's text as rows, each with its 0-based line number in that
 *  text — for a repair that rewrites rows in place and must keep every other
 *  line byte-for-byte (session-time-backfill). A torn or unparseable line is
 *  skipped. */
export function parseSessionLogText(text: string): Array<{ line: number; row: SessionLogRow }> {
  const rows: Array<{ line: number; row: SessionLogRow }> = [];
  text.split("\n").forEach((raw, line) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    try {
      rows.push({ line, row: JSON.parse(trimmed) as SessionLogRow });
    } catch { /* torn line */ }
  });
  return rows;
}

/** The authoritative meta row: the LAST one in the file (a degenerate log can
 *  carry several — manual edits, partial writes). */
export function sessionLogMeta(rows: readonly SessionLogRow[]): SessionMetaRow | null {
  let meta: SessionMetaRow | null = null;
  for (const row of rows) if (row.kind === "meta") meta = row;
  return meta;
}

/** The session's start date as YYYY-MM-DD (UTC), from the authoritative meta
 *  row; undefined when the log has none. */
export function sessionLogDate(path: string): string | undefined {
  const meta = sessionLogMeta(readSessionLogRows(path) ?? []);
  return meta && typeof meta.createdAt === "number" ? new Date(meta.createdAt).toISOString().split("T")[0] : undefined;
}

/** The pre-2026-05 single-blob session format (`{id}.json`), which a sync
 *  pull from an older machine can still deliver until the boot migration
 *  converts it. Owned here with the live format so no consumer parses a
 *  session file itself. Null when unreadable or not an object. */
export interface LegacySessionBlob {
  id?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  projectId?: string;
  messages?: ChatCompletionMessageParam[];
  compactedSummary?: string;
  compactedAt?: number;
}
export function readLegacySessionBlob(path: string): LegacySessionBlob | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as LegacySessionBlob : null;
  } catch {
    return null;
  }
}
