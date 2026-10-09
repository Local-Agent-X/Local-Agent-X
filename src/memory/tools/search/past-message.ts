/**
 * Read one prior-session message in full, by its id — the "read the rest"
 * for a search hit whose snippet was an excerpt. Session hits carry their
 * messages' ids (chunk metadata message_ids, from the session rows), and a
 * truncated hit names the first one (search-helpers excerptNote). Before this
 * there was no way to read past the excerpt: memory_get only reads the memory
 * directory, and recall only the current op.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { MemoryIndex } from "../../../memory/index.js";
import { readSessionLogRows, sessionLogMeta } from "../../session-log-rows.js";
import { describeWhen, localDate } from "../../retrieval-format.js";

const MAX_CHARS = 8000;

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join("\n");
  return "";
}

export function readPastMessage(memory: MemoryIndex, messageId: string): string {
  const sessionsDir = join(memory["dataDir"] as string, "sessions");
  if (!messageId || !existsSync(sessionsDir)) return `<past_message id="${messageId}">Not found.</past_message>`;
  for (const f of readdirSync(sessionsDir)) {
    if (!f.endsWith(".jsonl") || f.startsWith(".")) continue;
    const rows = readSessionLogRows(join(sessionsDir, f)) ?? [];
    const row = rows.find((r) => r.kind === "msg" && r.id === messageId);
    if (!row || row.kind !== "msg") continue;
    const meta = sessionLogMeta(rows);
    const when = describeWhen(row.timeUnknown
      ? { date: meta ? localDate(meta.createdAt) : undefined, date_approx: true }
      : { datetime: row.createdAt });
    const body = text(row.message.content);
    const shown = body.length > MAX_CHARS ? `${body.slice(0, MAX_CHARS)}…\n[message continues: ${body.length} characters in all]` : body;
    return `<past_message id="${messageId}" role="${row.message.role}" date=${JSON.stringify(when ?? "unknown")} chat=${JSON.stringify(meta?.title ?? "")} session="${meta?.id ?? f.slice(0, -6)}">\n` +
      "INSTRUCTION: This is from a PRIOR session — background reference, not the current conversation.\n\n" +
      `${shown}\n</past_message>`;
  }
  return `<past_message id="${messageId}">Not found in any stored session.</past_message>`;
}
