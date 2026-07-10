import type Database from "better-sqlite3";
import type { Chunk } from "../types.js";
import { bm25RankToScore, buildFtsQuery } from "../utils.js";

export function searchKeyword(
  db: InstanceType<typeof Database>,
  query: string,
  limit: number,
  sources?: string[],
  sessionFilter?: string | null
): Array<Chunk & { score: number }> {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  try {
    // Storage-layer cross-session gate (defense-in-depth on top of postProcess).
    // Scope comes from chunks.source, never nullable or model-authored metadata.
    const sessionWhere = sessionFilter !== undefined
      ? `AND (c.source IN ('entity', 'mind', 'personality', 'import')${sessionFilter ? " OR c.session_id = ?" : ""})`
      : "";
    const sql = `SELECT c.id, c.path, c.source, c.start_line, c.end_line, c.text, c.metadata, c.session_id, c.updated_at,
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
      session_id: string | null;
      updated_at: number;
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
        metadata: {
          ...(r.metadata ? JSON.parse(r.metadata) as Record<string, unknown> : {}),
          session_id: r.session_id ?? undefined,
        },
        updatedAt: r.updated_at,
        score: bm25RankToScore(r.rank),
      }));
  } catch {
    return [];
  }
}
