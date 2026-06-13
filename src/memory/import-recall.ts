import type Database from "better-sqlite3";

// Imported conversation history (ChatGPT/Claude) lives in the chunks table
// tagged metadata.source_type='import'/'claude-import' — NOT source='import':
// their `source` column is 'session', identical to native LAX sessions, so the
// import signal is the source_type. Each carries a per-conversation date in
// metadata JSON ({source_type, session_id, date}). recallByTime (Facts DB) and
// the daily-log files never see them, so a calendar-date recall for an imported
// era came back empty — and the agent wrongly concluded the history "predates"
// what it has. These read imports straight from the chunk store by their stored
// date, with no embeddings or FTS, so they answer regardless of index state.
// (claude-import chunks lack a date and are reachable via free-text search.)
const IMPORT_FILTER = "json_extract(metadata, '$.source_type') LIKE '%import%'";

export interface ImportChunkEntry {
  date: string;
  sessionId: string | null;
  path: string;
  text: string;
  truncated: boolean;
}

interface RangeOpts {
  maxRows?: number;
  maxCharsPerChunk?: number;
  maxTotalChars?: number;
}

const isoDay = (d: Date): string =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    .toISOString()
    .slice(0, 10);

/**
 * Imported-conversation chunks whose stored date falls in [since, until]
 * (inclusive, UTC days; `until` defaults to `since`). Oldest→newest, bounded
 * by the opts caps so a wide window can't dump the whole import.
 */
export function recallImportsByDate(
  db: InstanceType<typeof Database>,
  since: Date,
  until?: Date,
  opts: RangeOpts = {},
): ImportChunkEntry[] {
  const maxRows = opts.maxRows ?? 24;
  const maxCharsPerChunk = opts.maxCharsPerChunk ?? 1500;
  const maxTotalChars = opts.maxTotalChars ?? 16_000;

  const from = isoDay(since);
  const to = isoDay(until ?? since);
  if (to < from) return [];

  let rows: Array<{ date: string | null; session_id: string | null; path: string; text: string }>;
  try {
    rows = db
      .prepare(
        `SELECT json_extract(metadata, '$.date') AS date,
                json_extract(metadata, '$.session_id') AS session_id,
                path, text
           FROM chunks
          WHERE ${IMPORT_FILTER}
            AND json_extract(metadata, '$.date') >= ?
            AND json_extract(metadata, '$.date') <= ?
          ORDER BY date ASC, start_line ASC
          LIMIT ?`,
      )
      .all(from, to, maxRows) as typeof rows;
  } catch {
    return [];
  }

  const entries: ImportChunkEntry[] = [];
  let total = 0;
  for (const r of rows) {
    if (total >= maxTotalChars || !r.date) continue;
    let text = (r.text || "").trim();
    if (!text) continue;
    let truncated = false;
    if (text.length > maxCharsPerChunk) {
      text = text.slice(0, maxCharsPerChunk);
      truncated = true;
    }
    const remaining = maxTotalChars - total;
    if (text.length > remaining) {
      text = text.slice(0, Math.max(0, remaining));
      truncated = true;
    }
    entries.push({ date: r.date, sessionId: r.session_id ?? null, path: r.path, text, truncated });
    total += text.length;
  }
  return entries;
}

/**
 * Imported-history dates within `windowDays` of `target`, deduped and sorted.
 * Lets an empty-date answer point at nearby IMPORT days (not just the agent's
 * own daily-log era), so a 2025 miss surfaces 2025 import dates instead of the
 * agent inferring its history "starts" in 2026. Excludes the target date
 * itself — if that day had imports we wouldn't be in the empty branch.
 */
export function listNearbyImportDates(
  db: InstanceType<typeof Database>,
  target: Date,
  windowDays = 12,
): string[] {
  const center = isoDay(target);
  const lo = isoDay(new Date(target.getTime() - windowDays * 86_400_000));
  const hi = isoDay(new Date(target.getTime() + windowDays * 86_400_000));
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT json_extract(metadata, '$.date') AS date
           FROM chunks
          WHERE ${IMPORT_FILTER}
            AND json_extract(metadata, '$.date') >= ?
            AND json_extract(metadata, '$.date') <= ?
          ORDER BY date ASC LIMIT 24`,
      )
      .all(lo, hi) as Array<{ date: string | null }>;
    return rows.map((r) => r.date).filter((d): d is string => !!d && d !== center);
  } catch {
    return [];
  }
}
