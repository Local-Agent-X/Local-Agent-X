import type Database from "better-sqlite3";
import type { Chunk } from "../types.js";
import { bm25RankToScore, buildFtsQuery } from "../utils.js";

export function searchKeyword(
  db: InstanceType<typeof Database>,
  query: string,
  limit: number,
  sources?: string[],
  sessionFilter?: string
): Array<Chunk & { score: number }> {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  try {
    // Storage-layer cross-session gate (defense-in-depth on top of postProcess).
    // session_id IS NULL = profile-level chunks (entity, MIND, daily-log,
    // personality) — always allowed. Otherwise must match the active session.
    const sessionWhere = sessionFilter ? `AND (c.session_id IS NULL OR c.session_id = ?)` : "";
    const sql = `SELECT c.id, c.path, c.source, c.start_line, c.end_line, c.text, c.metadata,
                bm25(chunks_fts) as rank
         FROM chunks_fts f
         JOIN chunks c ON c.id = f.rowid
         WHERE chunks_fts MATCH ?
         ${sessionWhere}
         ORDER BY rank
         LIMIT ?`;
    const params: unknown[] = sessionFilter
      ? [ftsQuery, sessionFilter, limit]
      : [ftsQuery, limit];
    const rows = db
      .prepare(sql)
      .all(...params) as Array<{
      id: number;
      path: string;
      source: string;
      start_line: number;
      end_line: number;
      text: string;
      metadata: string | null;
      rank: number;
    }>;

    return rows
      .filter((r) => !sources || sources.includes(r.source))
      .map((r) => ({
        id: r.id,
        path: r.path,
        source: r.source,
        startLine: r.start_line,
        endLine: r.end_line,
        text: r.text,
        hash: "",
        metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
        score: bm25RankToScore(r.rank),
      }));
  } catch {
    return [];
  }
}
