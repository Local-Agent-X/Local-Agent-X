import type Database from "better-sqlite3";
import type { FactKind, RetainedFact } from "./types.js";
import { DEFAULT_MEMORY_CONFIG } from "./types.js";
import { rowToFact, slugify } from "./utils.js";
import { retain, invalidateFact } from "./index-facts.js";
import { findContradictions } from "./contradiction-sweep.js";

import { createLogger } from "../logger.js";
const contradictionLogger = createLogger("memory.contradiction");

// Hot-score for prompt injection. Confidence × exponential decay on age.
// At half_life days the score is 0.5×confidence; at 3× half_life it's ~12%.
// We compute this in JS rather than SQL because (a) we already pull a small
// candidate set, (b) the formula is easier to read in code, and (c) reusing
// the existing temporalHalfLifeDays config keeps decay tunable in one place.
function hotScore(fact: RetainedFact, nowMs: number, halfLifeDays: number): number {
  const ageMs = Math.max(0, nowMs - (fact.lastUpdated ?? fact.timestamp));
  const ageDays = ageMs / 86_400_000;
  const decay = Math.exp(-ageDays / halfLifeDays);
  return fact.confidence * decay;
}

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
  const newFact = facts[0];
  if (newFact.id !== undefined) autoInvalidateContradicting(db, newFact);
  return { ok: true, fact: newFact, newFactId: newFact.id };
}

// After inserting a fact, scan live facts that share at least one entity
// (or, if no entities, share a content keyword) and invalidate any that
// contradict the new one. Without this, every "stop X" correction just
// adds a new fact next to the original "do X" — both survive `valid_to
// IS NULL` and both flow into recallRecentFacts, so the model sees both
// rules and picks whichever fits the moment. The Spanish-greeting bug
// in HEART.md is the canonical case.
function autoInvalidateContradicting(
  db: InstanceType<typeof Database>,
  newFact: RetainedFact,
): void {
  const newId = newFact.id!;
  const candidates = findCandidatesForContradictionCheck(db, newFact);
  if (candidates.length === 0) return;

  const items = [
    { text: newFact.content, payload: newId },
    ...candidates.map(c => ({ text: c.content, payload: c.id! })),
  ];
  const pairs = findContradictions(items);
  for (const p of pairs) {
    if (p.drop === newId) continue; // never invalidate the fact we just inserted
    invalidateFact(db, p.drop, {
      reason: `superseded by remember #${newId}: auto-detected contradiction (overlap=${p.overlap.toFixed(2)})`,
      replacedBy: newId,
    });
    contradictionLogger.info(
      `[contradiction] facts: invalidated #${p.drop} ("${candidates.find(c => c.id === p.drop)?.content.slice(0, 60)}") ` +
      `superseded by #${newId} ("${newFact.content.slice(0, 60)}"), overlap=${p.overlap.toFixed(2)}`,
    );
  }
}

// Cheap candidate pool for the contradiction sweep. Entity overlap is the
// strong signal — facts mentioning the same person/project rarely cross
// topic boundaries. Cap at 50 so a noisy entity (e.g. the user's name
// mentioned in hundreds of facts) doesn't make every `remember` O(n).
function findCandidatesForContradictionCheck(
  db: InstanceType<typeof Database>,
  newFact: RetainedFact,
): RetainedFact[] {
  if (!newFact.entities || newFact.entities.length === 0) return [];
  const slugs = newFact.entities.map(e => slugify(e)).filter(Boolean);
  if (slugs.length === 0) return [];
  const placeholders = slugs.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT DISTINCT f.* FROM facts f
     JOIN entity_mentions em ON em.fact_id = f.id
     WHERE em.entity_slug IN (${placeholders})
       AND f.valid_to IS NULL
       AND f.id != ?
     ORDER BY f.last_updated DESC
     LIMIT 50`
  ).all(...slugs, newFact.id) as Array<Record<string, unknown>>;
  return rows.map(rowToFact);
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

// Used by context.ts for system-prompt injection. Returns the top N facts
// ranked by hot-score (confidence × recency-decay). We pull a candidate set
// of 3×limit from SQL ordered by last_updated, then rerank in JS — this
// gives high-confidence older facts a real chance to outrank low-confidence
// newer ones, instead of pure recency ordering where new mid-confidence
// chatter pushes durable knowledge off the prompt.
//
// Opinions still come through their own block in context.ts (back-compat);
// this is the new general-facts injector that surfaces world/observation
// content the agent saved via remember().
export function recallRecentFacts(
  db: InstanceType<typeof Database>,
  opts?: { kinds?: FactKind[]; minConfidence?: number; limit?: number; sinceMs?: number; halfLifeDays?: number }
): RetainedFact[] {
  const kinds = opts?.kinds ?? ["observation", "world", "experience"];
  const limit = opts?.limit ?? 30;
  const minConf = opts?.minConfidence ?? 0.5;
  const halfLife = opts?.halfLifeDays ?? DEFAULT_MEMORY_CONFIG.temporalHalfLifeDays;
  const placeholders = kinds.map(() => "?").join(",");
  const params: unknown[] = [...kinds, minConf];
  let sinceClause = "";
  if (opts?.sinceMs) {
    sinceClause = "AND last_updated >= ?";
    params.push(opts.sinceMs);
  }
  // Candidate window: 3× the requested limit, ordered by recency. Bigger
  // window catches high-confidence older facts that pure-recency ordering
  // would otherwise miss; 3× is enough for the rerank to find them without
  // pulling the whole table.
  params.push(limit * 3);
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

  const candidates = rows.map(rowToFact);
  const now = Date.now();
  const ranked = candidates
    .map((f) => ({ f, score: hotScore(f, now, halfLife) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.f);

  // Dedup-on-recall: at most one fact per (kind, primary-entity). Safety
  // net for facts that snuck past the auto-invalidation in rememberFact —
  // e.g. legacy migrated facts, or facts inserted directly via retain.
  // The first (highest hot-score) survivor wins; older or lower-confidence
  // entries in the same slot are dropped from the prompt injection but
  // remain queryable via recallByEntity / memory_recall.
  //
  // Facts with no @-entity tag (entities[] is empty) bypass dedup — those
  // are general observations about the user, not entity-scoped statements,
  // and collapsing them by kind alone would crush the prompt.
  const seen = new Set<string>();
  const out: RetainedFact[] = [];
  for (const f of ranked) {
    if (f.entities.length === 0) {
      out.push(f);
    } else {
      const key = `${f.kind}|${f.entities[0].toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
    if (out.length >= limit) break;
  }
  return out;
}

// Bump last_updated on a set of fact IDs. Used to "reinforce" facts that
// proved relevant in the current turn (matched a mentioned entity, returned
// by an agent-initiated recall). Reinforcement is what lets long-tail facts
// stay hot when they keep coming up. We do NOT reinforce facts just for
// appearing in the default top-N injection — that would defeat the point of
// recency decay.
export function reinforceFacts(
  db: InstanceType<typeof Database>,
  ids: number[]
): number {
  const valid = ids.filter((n) => Number.isFinite(n));
  if (valid.length === 0) return 0;
  const now = Date.now();
  const placeholders = valid.map(() => "?").join(",");
  const r = db
    .prepare(`UPDATE facts SET last_updated = ? WHERE id IN (${placeholders}) AND valid_to IS NULL`)
    .run(now, ...valid);
  return r.changes;
}
