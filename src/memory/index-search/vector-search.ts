import type Database from "better-sqlite3";
import type { Chunk } from "../types.js";
import { cosineSimilarity } from "../utils.js";

export function searchVector(
  db: InstanceType<typeof Database>,
  queryVec: number[],
  limit: number,
  sources?: string[],
  sessionFilter?: string
): Array<Chunk & { score: number }> {
  const BATCH_SIZE = 1000;
  const sourceFilter = sources ? `AND source IN (${sources.map(() => "?").join(",")})` : "";
  // Same gate as searchKeyword: profile-level (NULL) + active session only.
  const sessionWhere = sessionFilter ? `AND (session_id IS NULL OR session_id = ?)` : "";
  const baseParams: unknown[] = sources ? [...sources] : [];
  const params = sessionFilter ? [...baseParams, sessionFilter] : baseParams;

  const totalCount = (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM chunks WHERE embedding IS NOT NULL ${sourceFilter} ${sessionWhere}`
      )
      .get(...params) as { n: number }
  ).n;

  const results: Array<Chunk & { score: number }> = [];
  let minResultScore = -Infinity;

  for (let offset = 0; offset < totalCount; offset += BATCH_SIZE) {
    const batch = db
      .prepare(
        `SELECT id, path, source, start_line, end_line, text, embedding, metadata
         FROM chunks WHERE embedding IS NOT NULL ${sourceFilter} ${sessionWhere}
         LIMIT ? OFFSET ?`
      )
      .all(...params, BATCH_SIZE, offset) as Array<{
      id: number;
      path: string;
      source: string;
      start_line: number;
      end_line: number;
      text: string;
      embedding: string;
      metadata: string | null;
    }>;

    for (const row of batch) {
      let embedding: number[];
      try {
        embedding = JSON.parse(row.embedding);
      } catch {
        continue;
      }

      const similarity = cosineSimilarity(queryVec, embedding);
      if (!Number.isFinite(similarity)) continue;

      if (results.length < limit * 2 || similarity > minResultScore) {
        results.push({
          id: row.id,
          path: row.path,
          source: row.source,
          startLine: row.start_line,
          endLine: row.end_line,
          text: row.text,
          hash: "",
          metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
          score: similarity,
        });

        if (results.length > limit * 4) {
          results.sort((a, b) => b.score - a.score);
          results.length = limit * 2;
          minResultScore = results[results.length - 1].score;
        }
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
