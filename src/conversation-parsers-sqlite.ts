// SQLite memory store parser.
// Many AI agents persist memory in SQLite databases. Schemas vary wildly,
// so we infer column meaning from name heuristics: which column holds the
// role, content, timestamp, and conversation grouping key.
//
// Output matches conversation-parsers.ts so the rest of the ingest
// pipeline (chunking, indexing, fact extraction) is reused as-is.

import { basename, extname } from "node:path";
import type { ParsedConversation, ParsedMessage } from "./conversation-parsers.js";
import { createLogger } from "./logger.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const logger = createLogger("conversation-parsers-sqlite");

// ── Column-name heuristics ──

const ROLE_COLUMNS = ["role", "sender", "author", "type", "speaker", "from_", "from", "user_role", "msg_type", "actor"];
const CONTENT_COLUMNS = ["content", "text", "message", "body", "msg", "payload", "data", "value", "snippet", "memory"];
const TIMESTAMP_COLUMNS = ["timestamp", "created_at", "createdat", "ts", "time", "date", "create_time", "created", "inserted_at", "occurred_at"];
const CONVERSATION_COLUMNS = ["conversation_id", "conversationid", "chat_id", "chatid", "thread_id", "threadid", "session_id", "sessionid", "convo_id", "dialog_id"];
const ID_COLUMNS = ["id", "uuid", "msg_id", "message_id"];

const MEMORY_TABLE_HINTS = ["messages", "memories", "memory", "conversations", "chats", "history", "facts", "transcripts"];

const USER_ROLE_VALUES = new Set(["user", "human", "you", "me", "u", "0", "user_message"]);
const ASSISTANT_ROLE_VALUES = new Set(["assistant", "ai", "bot", "agent", "model", "a", "1", "agent_message", "assistant_message"]);

// ── Types ──

interface SqliteHandle {
  prepare: (sql: string) => { all: () => unknown[]; get: () => unknown };
  close: () => void;
}

interface TableMapping {
  table: string;
  roleCol: string | null;
  contentCol: string;
  timestampCol: string | null;
  conversationCol: string | null;
  idCol: string;
}

interface RawRow {
  id: unknown;
  rawRole: unknown;
  content: string;
  timestamp: number | undefined;
  conversationKey: string;
}

// ── Column matching ──

function findColumn(columns: string[], candidates: string[]): string | null {
  const lower = columns.map(c => c.toLowerCase());
  for (const cand of candidates) {
    const idx = lower.indexOf(cand);
    if (idx >= 0) return columns[idx];
  }
  for (const cand of candidates) {
    for (let i = 0; i < lower.length; i++) {
      if (lower[i].includes(cand)) return columns[i];
    }
  }
  return null;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// ── Value normalization ──

function inferRole(value: unknown): "user" | "assistant" | null {
  if (value == null) return null;
  const s = String(value).toLowerCase().trim();
  if (USER_ROLE_VALUES.has(s)) return "user";
  if (ASSISTANT_ROLE_VALUES.has(s)) return "assistant";
  return null;
}

function extractContent(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") {
          const obj = parsed as Record<string, unknown>;
          const inner = obj.content ?? obj.text ?? obj.message ?? obj.body;
          if (typeof inner === "string" && inner.trim()) return inner.trim();
        }
      } catch { /* not JSON, use as-is */ }
    }
    return trimmed;
  }
  if (typeof value === "object") {
    try { return JSON.stringify(value); } catch { return ""; }
  }
  return String(value).trim();
}

function normalizeTimestamp(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === "number") {
    if (!isFinite(value) || value <= 0) return undefined;
    if (value > 1e15) return Math.round(value / 1000); // microseconds → ms
    if (value > 1e12) return value;                     // already ms
    if (value > 1e9) return value * 1000;               // seconds → ms
    return undefined;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (!isNaN(ms)) return ms;
    const num = Number(value);
    if (!isNaN(num)) return normalizeTimestamp(num);
  }
  return undefined;
}

// ── Schema inspection ──

function findMemoryTables(db: SqliteHandle): string[] {
  const allTables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all() as Array<{ name: string }>).map(r => r.name);

  return allTables.filter(t => {
    const lower = t.toLowerCase();
    return MEMORY_TABLE_HINTS.some(h => lower === h || lower.includes(h));
  });
}

function mapTable(db: SqliteHandle, table: string): TableMapping | null {
  let cols: Array<{ name: string }>;
  try {
    cols = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name: string }>;
  } catch (e) {
    logger.warn(`[sqlite] PRAGMA failed for ${table}: ${(e as Error).message}`);
    return null;
  }
  const colNames = cols.map(c => c.name);
  if (colNames.length === 0) return null;

  const contentCol = findColumn(colNames, CONTENT_COLUMNS);
  if (!contentCol) return null;

  const idCol = findColumn(colNames, ID_COLUMNS) || "rowid";

  return {
    table,
    roleCol: findColumn(colNames, ROLE_COLUMNS),
    contentCol,
    timestampCol: findColumn(colNames, TIMESTAMP_COLUMNS),
    conversationCol: findColumn(colNames, CONVERSATION_COLUMNS),
    idCol,
  };
}

// ── Row extraction ──

function extractRows(db: SqliteHandle, m: TableMapping): RawRow[] {
  const selectCols: string[] = [
    `${quoteIdent(m.idCol)} AS id`,
    `${quoteIdent(m.contentCol)} AS content`,
  ];
  if (m.roleCol) selectCols.push(`${quoteIdent(m.roleCol)} AS role`);
  if (m.timestampCol) selectCols.push(`${quoteIdent(m.timestampCol)} AS ts`);
  if (m.conversationCol) selectCols.push(`${quoteIdent(m.conversationCol)} AS convo`);

  const orderBy = m.timestampCol ? "ORDER BY ts ASC, id ASC" : "ORDER BY id ASC";
  const sql = `SELECT ${selectCols.join(", ")} FROM ${quoteIdent(m.table)} ${orderBy}`;

  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.prepare(sql).all() as Array<Record<string, unknown>>;
  } catch (e) {
    logger.warn(`[sqlite] Query failed for ${m.table}: ${(e as Error).message}`);
    return [];
  }

  return rows.map(r => ({
    id: r.id,
    rawRole: r.role,
    content: extractContent(r.content),
    timestamp: normalizeTimestamp(r.ts),
    conversationKey: r.convo != null ? String(r.convo) : "default",
  }));
}

// ── Conversation grouping ──

function groupRows(rows: RawRow[], m: TableMapping, dbId: string): ParsedConversation[] {
  const groups = new Map<string, RawRow[]>();
  for (const row of rows) {
    if (!row.content) continue;
    let arr = groups.get(row.conversationKey);
    if (!arr) { arr = []; groups.set(row.conversationKey, arr); }
    arr.push(row);
  }

  const out: ParsedConversation[] = [];
  for (const [convoKey, convoRows] of groups) {
    const messages: ParsedMessage[] = [];

    if (m.roleCol) {
      // Explicit role column — trust it. Rows without recognizable role
      // are kept as user-side entries (still useful as searchable content).
      for (const row of convoRows) {
        const role = inferRole(row.rawRole) || "user";
        messages.push({ role, content: row.content, timestamp: row.timestamp });
      }
    } else {
      // No role column — treat every row as an independent memory entry
      // ("user-side"). chunkConversationPairs will emit one chunk per row
      // with "(no response)" as the assistant side, which is correct for
      // fact/memory-style tables.
      for (const row of convoRows) {
        messages.push({ role: "user", content: row.content, timestamp: row.timestamp });
      }
    }

    if (messages.length === 0) continue;

    const earliestTs = messages.find(m => m.timestamp)?.timestamp;
    out.push({
      id: `sqlite-${dbId}-${m.table}-${convoKey}`,
      title: convoKey === "default" ? `${m.table}` : `${m.table} (${convoKey})`,
      messages,
      createTime: earliestTs,
      source: `sqlite-${m.table}`,
    });
  }

  return out;
}

// ── Public API ──

export function parseSQLiteFile(path: string): ParsedConversation[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3");

  let db: SqliteHandle;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true }) as SqliteHandle;
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("locked") || msg.includes("busy")) {
      throw new Error(`Database is locked at ${path}. Close the app that owns this file and try again.`);
    }
    throw new Error(`Cannot open SQLite database: ${msg}`);
  }

  try {
    const tables = findMemoryTables(db);
    if (tables.length === 0) {
      logger.info(`[sqlite] No memory-shaped tables in ${basename(path)}`);
      return [];
    }

    const dbId = basename(path).replace(extname(path), "").replace(/[^a-zA-Z0-9_-]/g, "_");
    const conversations: ParsedConversation[] = [];

    for (const table of tables) {
      const mapping = mapTable(db, table);
      if (!mapping) {
        logger.info(`[sqlite] Skipping ${table}: no recognizable content column`);
        continue;
      }
      const rows = extractRows(db, mapping);
      if (rows.length === 0) continue;
      const grouped = groupRows(rows, mapping, dbId);
      conversations.push(...grouped);
      logger.info(`[sqlite] ${table}: ${rows.length} rows → ${grouped.length} conversation(s)`);
    }

    return conversations;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}
