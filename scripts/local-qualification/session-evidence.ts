import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MARKER } from "./chat-evidence.js";
import type { CompactionResult } from "./types.js";

export interface SessionRow {
  kind?: string;
  content?: string;
}

/** Reads the persisted JSONL rows of one isolated session; missing file = no rows. */
export function readSessionRows(dataDir: string, sessionId: string): SessionRow[] {
  const path = join(dataDir, "sessions", `${sessionId}.jsonl`);
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as SessionRow);
  } catch {
    return [];
  }
}

export function readPersistedSummary(rows: SessionRow[]): string | null {
  return [...rows].reverse().find((row) => row.kind === "summary")?.content ?? null;
}

export function persistedMessageCount(rows: SessionRow[]): number {
  return rows.filter((row) => row.kind === "msg").length;
}

export function compactionEvidence(
  rows: SessionRow[],
  ok: boolean,
  backgroundRequests: number,
  persistedMessages: number,
): CompactionResult {
  const summary = readPersistedSummary(rows);
  const leadingConversationRow = rows.find((row) => row.kind !== "meta");
  return {
    ok,
    backgroundRequests,
    persistedMessageCount: persistedMessages,
    persistedSummary: summary !== null,
    summaryIsLeading: leadingConversationRow?.kind === "summary"
      && typeof leadingConversationRow.content === "string"
      && leadingConversationRow.content.startsWith("[COMPACTED CONTEXT"),
    summaryContainsMarker: summary?.includes(MARKER) ?? false,
  };
}
