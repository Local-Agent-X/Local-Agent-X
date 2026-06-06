/**
 * Session message log — single source of truth for chat conversation history.
 *
 * Each session is one `~/.lax/sessions/{id}.jsonl` file:
 *   - First line: `{"kind":"meta", id, title, createdAt, updatedAt, ...}`
 *   - Subsequent lines: `{"kind":"msg", message: <ChatCompletionMessageParam>, createdAt}`
 *
 * The file is rewritten atomically on save (via atomicWriteFileSync). Multiple
 * meta lines may exist in degenerate cases (manual edits, partial writes); the
 * reader treats the LAST meta line in the file as authoritative.
 *
 * Why this exists: the legacy single-blob `{id}.json` format made
 * `session.messages` a parallel source of truth alongside per-op
 * `op-messages.jsonl`. The two stores updated at different times by different
 * code paths, and short replies ("yes") could land before the prior turn's
 * `session.messages` write reached disk — losing the question the reply was
 * answering. The jsonl format gives us one file per session with a
 * deterministic projection, eliminating the divergence.
 *
 * Migration: `migrateAllLegacy()` converts every `{id}.json` to `{id}.jsonl`
 * and renames the original to `{id}.json.pre-migration` as a safety net. The
 * function is idempotent — re-running on an already-migrated dir is a no-op.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./utils.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { Session } from "../types.js";
import { COMPACTION_PREFIX } from "../types.js";
import type { ToolResultStatus } from "../types.js";
import { parseStatusHeader } from "../tools/result-helpers.js";

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
  message: ChatCompletionMessageParam;
  createdAt: string;
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

export type SessionLogRow = SessionMetaRow | SessionMessageRow | SessionSummaryRow;

/** Pre-Item-3 meta shape — kept only so logs migrated by the previous
 *  Phase 2 step (which wrote `compactedSummary`/`compactedAt` onto the
 *  meta line) still project correctly. New writes never include these. */
interface LegacyCompactionMeta {
  compactedSummary?: string;
  compactedAt?: number;
}

const JSONL_SUFFIX = ".jsonl";
const LEGACY_SUFFIX = ".json";
const PRE_MIGRATION_SUFFIX = ".json.pre-migration";

function jsonlPath(dir: string, id: string): string {
  return join(dir, id + JSONL_SUFFIX);
}

function legacyJsonPath(dir: string, id: string): string {
  return join(dir, id + LEGACY_SUFFIX);
}

export function sessionLogExists(dir: string, id: string): boolean {
  return existsSync(jsonlPath(dir, id));
}

/**
 * Read a session's jsonl file and project it into the in-memory Session
 * shape, applying any compaction summary rows. Projection rule:
 *   - Walk every row in file order.
 *   - Maintain a `recentMsgs` buffer.
 *   - Each `msg` row appends to the buffer.
 *   - Each `summary` row clears the buffer and remembers its content
 *     (latest summary wins).
 *   - Final messages = `[{role:"system", content: latestSummary}, ...recentMsgs]`
 *     when any summary was seen, else just `recentMsgs`.
 *
 * Backward-compat: pre-Item-3 logs stored `compactedSummary`/`compactedAt`
 * on the meta line. If those are present and no `summary` row exists,
 * synthesise the projection from them.
 */
export function readSessionLog(dir: string, id: string): Session | null {
  const p = jsonlPath(dir, id);
  if (!existsSync(p)) return null;
  let content: string;
  try {
    content = readFileSync(p, "utf-8");
  } catch {
    return null;
  }
  const lines = content.split("\n");
  let meta: SessionMetaRow | null = null;
  let legacyCompaction: LegacyCompactionMeta = {};
  let recentMsgs: ChatCompletionMessageParam[] = [];
  let summaryContent: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: SessionLogRow;
    try {
      row = JSON.parse(trimmed) as SessionLogRow;
    } catch {
      continue;
    }
    if (row.kind === "meta") {
      meta = row;
      const legacy = row as SessionMetaRow & LegacyCompactionMeta;
      if (typeof legacy.compactedSummary === "string") legacyCompaction.compactedSummary = legacy.compactedSummary;
      if (typeof legacy.compactedAt === "number") legacyCompaction.compactedAt = legacy.compactedAt;
    } else if (row.kind === "msg" && row.message) {
      recentMsgs.push(row.message);
    } else if (row.kind === "summary") {
      summaryContent = row.content;
      recentMsgs = [];
    }
  }
  if (!meta) return null;

  // Apply legacy meta-stored compaction if no summary row was present.
  // Pre-Item-3 logs kept the FULL message history with `compactedAt` as a
  // slice hint; synthesise the same projection by trimming the buffer.
  if (summaryContent === null && legacyCompaction.compactedSummary && typeof legacyCompaction.compactedAt === "number") {
    summaryContent = legacyCompaction.compactedSummary;
    recentMsgs = recentMsgs.slice(legacyCompaction.compactedAt);
  }

  const projectedMessages: ChatCompletionMessageParam[] = summaryContent !== null
    ? [{ role: "system", content: summaryContent } as ChatCompletionMessageParam, ...recentMsgs]
    : recentMsgs;

  return {
    id: meta.id,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    ...(meta.projectId ? { projectId: meta.projectId } : {}),
    messages: projectedMessages,
  };
}

/**
 * UI projection of a Session. Same model state, different shape: drops
 * `tool` rows, replaces `tool_calls` on assistants with a synthetic
 * `_tools` array the chat renderer turns into expandable tool cards.
 * Compaction summary stays as a leading `system` message (the UI knows
 * how to render that).
 *
 * Why a separate projection: model state and display state have different
 * requirements. The model needs full tool_calls / tool_result structure
 * across turns to chain follow-ups. The UI needs the visible conversation
 * plus enough tool-call breadcrumbs to rebuild the tool cards a returning
 * user expects to see (without this they vanish on chat-switch+back, when
 * hydrateChat overwrites the client-side `_tools`).
 *
 * Frontend-facing API endpoints serve this projection. Model-facing code
 * paths (`prepareAgentRequest`, `seedOpMessages`) read the rich form.
 */
export function projectSessionForUI(session: Session): Session {
  // Index tool rows by tool_call_id so we can attach results to the
  // assistant that triggered them. JSONL preserves order, so the latest
  // result for a given id is authoritative.
  const toolResults = new Map<string, string>();
  for (const m of session.messages) {
    if (m.role !== "tool") continue;
    const id = (m as unknown as { tool_call_id?: string }).tool_call_id;
    const content = typeof m.content === "string" ? m.content : "";
    if (id) toolResults.set(id, content);
  }

  type ToolEvent = { type: "start" | "end"; name: string; args?: Record<string, unknown>; result?: string; allowed?: boolean; status?: ToolResultStatus };
  type UIAssistant = ChatCompletionMessageParam & { _tools?: ToolEvent[] };

  const messages: ChatCompletionMessageParam[] = [];
  // Tool-call breadcrumbs accumulated across one assistant turn. The live
  // UI builds a single streaming bubble per turn and stacks `tool_start →
  // tool_end` events into its `_tools` array — even if the model emits
  // multiple intermediate `assistant` entries (one carrying tool_calls,
  // another carrying text). The projection mirrors that: tools accumulate
  // until the next visible text bubble (same turn) and attach there.
  let pendingTools: ToolEvent[] = [];
  const flushPending = () => {
    if (pendingTools.length === 0) return;
    const out: UIAssistant = { role: "assistant", content: "", _tools: pendingTools };
    messages.push(out);
    pendingTools = [];
  };

  for (const m of session.messages) {
    if (m.role === "tool") continue;
    if (m.role === "user") {
      // User message marks the end of the prior assistant turn. If tools
      // accumulated without a text bubble to attach to, emit them as a
      // standalone empty-content assistant so the cards still render.
      flushPending();
      messages.push(m);
      continue;
    }
    if (m.role === "assistant") {
      const tcalls = (m as unknown as { tool_calls?: Array<{ id: string; function?: { name: string; arguments: string } }> }).tool_calls;
      if (Array.isArray(tcalls)) {
        for (const tc of tcalls) {
          const name = tc.function?.name || "tool";
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function?.arguments || "{}"); } catch {}
          pendingTools.push({ type: "start", name, args });
          const result = toolResults.get(tc.id) || "";
          pendingTools.push({ type: "end", name, allowed: true, result: result.slice(0, 500), status: parseStatusHeader(result) });
        }
      }
      const text = typeof m.content === "string" ? m.content : "";
      // No text → defer; the next text bubble (same turn) inherits these
      // tools as its _tools. The flush on the next user message (or at
      // end-of-walk) covers the turn-ends-with-no-text case.
      if (!text) continue;
      const out: UIAssistant = { role: "assistant", content: text };
      if (pendingTools.length > 0) {
        out._tools = pendingTools;
        pendingTools = [];
      }
      messages.push(out);
      continue;
    }
    messages.push(m);
  }
  flushPending();
  return { ...session, messages };
}

/** Disk-read convenience: load + project. Equivalent to
 *  `readSessionLog(...).then(projectSessionForUI)`. */
export function readSessionLogForUI(dir: string, id: string): Session | null {
  const session = readSessionLog(dir, id);
  return session ? projectSessionForUI(session) : null;
}

/**
 * Atomically rewrite a session's jsonl file from a Session value.
 *
 * If `session.messages[0]` is a system message starting with the
 * compaction marker, it's written back as a `summary` row (with the
 * remaining messages as msg rows) so the next read projects the
 * compaction state correctly. Other system messages are written as
 * regular msg rows.
 */
export function writeSessionLog(dir: string, session: Session): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const meta: SessionMetaRow = {
    kind: "meta",
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.projectId ? { projectId: session.projectId } : {}),
  };

  const lines: string[] = [JSON.stringify(meta)];
  const now = new Date().toISOString();

  const first = session.messages[0];
  const compactionLeader =
    first &&
    first.role === "system" &&
    typeof first.content === "string" &&
    first.content.startsWith(COMPACTION_PREFIX);

  if (compactionLeader) {
    // Write the summary FIRST so that on read its "clear buffer + set
    // summary" effect leaves only the trailing msg rows visible, and
    // they project back to the same `[system_summary, ...tail]` shape.
    const summaryRow: SessionSummaryRow = {
      kind: "summary",
      content: first.content as string,
      createdAt: now,
    };
    lines.push(JSON.stringify(summaryRow));
    for (const m of session.messages.slice(1)) {
      const row: SessionMessageRow = { kind: "msg", message: m, createdAt: now };
      lines.push(JSON.stringify(row));
    }
  } else {
    for (const m of session.messages) {
      const row: SessionMessageRow = { kind: "msg", message: m, createdAt: now };
      lines.push(JSON.stringify(row));
    }
  }
  atomicWriteFileSync(jsonlPath(dir, session.id), lines.join("\n") + "\n");
}

export function deleteSessionLog(dir: string, id: string): void {
  const p = jsonlPath(dir, id);
  if (existsSync(p)) {
    try { unlinkSync(p); } catch { /* best-effort */ }
  }
  const backup = join(dir, id + PRE_MIGRATION_SUFFIX);
  if (existsSync(backup)) {
    try { unlinkSync(backup); } catch { /* best-effort */ }
  }
}

/** List every session id that has a jsonl file in the directory. */
export function listSessionIds(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith(JSONL_SUFFIX) && !f.startsWith("."))
    .map(f => f.slice(0, -JSONL_SUFFIX.length));
}

/**
 * Migrate one legacy `{id}.json` to `{id}.jsonl`. Returns true if migrated.
 *
 * Legacy sessions with `compactedSummary` / `compactedAt` get their
 * compaction projected into a leading `system` message (matching the
 * new in-memory shape) before write — the .jsonl writer then emits that
 * leader as a `summary` row, preserving compaction across the migration.
 */
export function migrateLegacyJsonToJsonl(dir: string, id: string): boolean {
  const newPath = jsonlPath(dir, id);
  const oldPath = legacyJsonPath(dir, id);
  if (existsSync(newPath)) return false;
  if (!existsSync(oldPath)) return false;
  let parsed: Session & LegacyCompactionMeta;
  try {
    parsed = JSON.parse(readFileSync(oldPath, "utf-8")) as Session & LegacyCompactionMeta;
  } catch {
    return false;
  }
  if (!parsed || typeof parsed.id !== "string") return false;

  // Project legacy compactedSummary/compactedAt into a leading system
  // message so the new writer emits a real `summary` row.
  if (
    parsed.compactedSummary &&
    typeof parsed.compactedAt === "number" &&
    parsed.compactedAt > 0 &&
    Array.isArray(parsed.messages) &&
    parsed.compactedAt < parsed.messages.length
  ) {
    const tail = parsed.messages.slice(parsed.compactedAt);
    parsed = {
      ...parsed,
      messages: [
        { role: "system", content: parsed.compactedSummary } as ChatCompletionMessageParam,
        ...tail,
      ],
    };
  }

  writeSessionLog(dir, parsed as Session);
  try {
    renameSync(oldPath, oldPath + ".pre-migration");
  } catch {
    /* best-effort — the jsonl is the new source of truth, the legacy file
       is at worst a duplicate that's now ignored by readers. */
  }
  return true;
}

/**
 * Idempotent on-startup migration. Scans the dir for legacy `{id}.json`
 * files (excluding `.metadata.json`/`.pre-migration` siblings); converts
 * each to `{id}.jsonl` if not already present.
 */
export function migrateAllLegacy(dir: string): { migrated: number; skipped: number } {
  if (!existsSync(dir)) return { migrated: 0, skipped: 0 };
  const files = readdirSync(dir).filter(
    f => f.endsWith(LEGACY_SUFFIX) && !f.startsWith(".") && !f.endsWith(".pre-migration"),
  );
  let migrated = 0;
  let skipped = 0;
  for (const f of files) {
    const id = f.slice(0, -LEGACY_SUFFIX.length);
    if (migrateLegacyJsonToJsonl(dir, id)) migrated++;
    else skipped++;
  }
  return { migrated, skipped };
}
