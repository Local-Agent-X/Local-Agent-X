import type Database from "better-sqlite3";
import type { FactKind, RetainedFact } from "./types.js";
import { rowToFact } from "./utils.js";
import { retain, invalidateFact } from "./index-facts.js";

// Single-fact agent-facing API. Sits on top of the bulk retain/invalidate
// primitives in index-facts.ts. The bulk path expects parsed bullet lines
// and operates on multiple facts at once; the agent needs plain-English in,
// substring-identified-out, with refusal on ambiguity.

const KIND_PREFIX: Record<FactKind, string> = {
  world: "W",
  experience: "B",
  opinion: "O",
  observation: "S",
};

export interface OneFactResult {
  ok: boolean;
  error?: string;
  matches?: number;
  // First 5 matches' content (truncated), shown when the substring is ambiguous
  // so the agent can pick a more specific one without a separate lookup call.
  preview?: string[];
  fact?: RetainedFact;
  newFactId?: number;
  oldFactId?: number;
}

function formatBullet(content: string, kind: FactKind, confidence: number): string {
  return `- ${KIND_PREFIX[kind]}(c=${confidence.toFixed(2)}) ${content.trim()}`;
}

export function rememberFact(
  db: InstanceType<typeof Database>,
  hasFts: boolean,
  content: string,
  opts?: { kind?: FactKind; confidence?: number; sourceFile?: string }
): OneFactResult {
  const trimmed = content.trim();
  if (trimmed.length < 3) return { ok: false, error: "content too short (min 3 chars)" };

  const kind = opts?.kind ?? "observation";
  const confidence = opts?.confidence ?? 1.0;
  const bullet = formatBullet(trimmed, kind, confidence);
  const facts = retain(db, hasFts, bullet, opts?.sourceFile ?? "agent-tool");
  if (facts.length === 0) {
    return { ok: false, error: "fact already exists or failed to insert" };
  }
  return { ok: true, fact: facts[0], newFactId: facts[0].id };
}

export function findOneFactByContent(
  db: InstanceType<typeof Database>,
  query: string,
  opts?: { includeInvalidated?: boolean }
): { fact?: RetainedFact; matches: number; preview?: string[] } {
  const validFilter = opts?.includeInvalidated ? "" : "AND valid_to IS NULL";
  const rows = db
    .prepare(
      `SELECT * FROM facts WHERE content LIKE ? ${validFilter} ORDER BY timestamp DESC`
    )
    .all(`%${query}%`) as Array<Record<string, unknown>>;

  if (rows.length === 0) return { matches: 0 };
  if (rows.length === 1) return { fact: rowToFact(rows[0]), matches: 1 };
  return {
    matches: rows.length,
    preview: rows.slice(0, 5).map((r) => (r.content as string).slice(0, 100)),
  };
}

export function updateFact(
  db: InstanceType<typeof Database>,
  hasFts: boolean,
  query: string,
  newContent: string,
  opts?: { kind?: FactKind; confidence?: number; sourceFile?: string }
): OneFactResult {
  const trimmed = newContent.trim();
  if (trimmed.length < 3) return { ok: false, error: "new content too short (min 3 chars)" };

  const found = findOneFactByContent(db, query);
  if (found.matches === 0) {
    return { ok: false, error: `no fact matched "${query}"`, matches: 0 };
  }
  if (found.matches > 1) {
    return {
      ok: false,
      error: `ambiguous: ${found.matches} facts match "${query}". Use a more specific substring.`,
      matches: found.matches,
      preview: found.preview,
    };
  }
  const oldFact = found.fact!;
  const kind = opts?.kind ?? oldFact.kind;
  const confidence = opts?.confidence ?? oldFact.confidence;
  const bullet = formatBullet(trimmed, kind, confidence);
  const newFacts = retain(db, hasFts, bullet, opts?.sourceFile ?? "agent-tool");
  if (newFacts.length === 0) {
    return { ok: false, error: "new content is duplicate of an existing fact" };
  }
  const newFact = newFacts[0];
  invalidateFact(db, oldFact.id!, {
    reason: `superseded by ${newFact.id}: agent update_fact`,
    replacedBy: newFact.id,
  });
  return { ok: true, fact: newFact, newFactId: newFact.id, oldFactId: oldFact.id };
}

export function forgetFact(
  db: InstanceType<typeof Database>,
  query: string
): OneFactResult {
  const found = findOneFactByContent(db, query);
  if (found.matches === 0) {
    return { ok: false, error: `no fact matched "${query}"`, matches: 0 };
  }
  if (found.matches > 1) {
    return {
      ok: false,
      error: `ambiguous: ${found.matches} facts match "${query}". Use a more specific substring.`,
      matches: found.matches,
      preview: found.preview,
    };
  }
  const oldFact = found.fact!;
  invalidateFact(db, oldFact.id!, { reason: "agent forget" });
  return { ok: true, fact: oldFact, oldFactId: oldFact.id };
}

// Used by context.ts for system-prompt injection. Returns the top N recent
// non-invalidated facts above the confidence floor, ordered by last_updated.
// Opinions still come through their own block in context.ts (back-compat);
// this is the new general-facts injector that surfaces world/observation
// content the agent saved via remember().
export function recallRecentFacts(
  db: InstanceType<typeof Database>,
  opts?: { kinds?: FactKind[]; minConfidence?: number; limit?: number; sinceMs?: number }
): RetainedFact[] {
  const kinds = opts?.kinds ?? ["observation", "world", "experience"];
  const limit = opts?.limit ?? 30;
  const minConf = opts?.minConfidence ?? 0.5;
  const placeholders = kinds.map(() => "?").join(",");
  const params: unknown[] = [...kinds, minConf];
  let sinceClause = "";
  if (opts?.sinceMs) {
    sinceClause = "AND last_updated >= ?";
    params.push(opts.sinceMs);
  }
  params.push(limit);
  const rows = db
    .prepare(
      `SELECT * FROM facts
       WHERE kind IN (${placeholders})
         AND confidence >= ?
         AND valid_to IS NULL
         ${sinceClause}
       ORDER BY last_updated DESC
       LIMIT ?`
    )
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map(rowToFact);
}
