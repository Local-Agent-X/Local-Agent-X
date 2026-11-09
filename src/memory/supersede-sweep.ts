/**
 * Background sweep over stored facts: each one asks the resolver which older
 * current facts it makes stale, and those are ended as replaced by it.
 *
 * retainSmart asks that question once, when a statement arrives, so a fact
 * saved by another path (remember, imports, an older resolver that could not
 * see it) or before the write-time rules existed never gets the answer. On
 * 2026-11-04 the user's May and October retatrutide vials were both current
 * among ~60 retatrutide facts. The owner's call: memory manages itself; the
 * sweep, not a person, brings stored facts up to date, and an ended fact stays
 * on its entity page as history.
 *
 * Every ending goes through resolverMayEnd (never backwards; the user's words
 * only in favour of a newer statement of theirs) and records its replacement,
 * so it is history the purge keeps, never a deletion.
 *
 * Order: facts saved since the last run first, then the backlog newest to
 * oldest, `budget` facts per run. Two watermarks in `meta` carry the place
 * across runs and restarts.
 */
import type Database from "better-sqlite3";
import type { RetainedFact } from "./types.js";
import type { ResolverDecision } from "./resolver.js";
import { rowToFact } from "./utils.js";
import { findResolverCandidates, type ResolverCandidateRow } from "./resolver-candidates.js";
import { invalidateFact } from "./index-facts-invalidate.js";
import { createLogger } from "../logger.js";

const logger = createLogger("memory.supersede-sweep");

const NEWEST_SEEN = "supersede_sweep_newest_seen";
const BACKLOG_BELOW = "supersede_sweep_backlog_below";
const CANDIDATES = 5;

export type Resolve = (content: string, candidates: ResolverCandidateRow[]) => Promise<ResolverDecision>;

export interface SweepResult {
  examined: number;
  /** The facts this run ended, and the facts that replaced them. */
  ended: RetainedFact[];
  replacing: RetainedFact[];
  /** Backlog left for later runs. */
  backlogLeft: boolean;
}

function readMark(db: InstanceType<typeof Database>, key: string): number | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? Number(row.value) : null;
}

function writeMark(db: InstanceType<typeof Database>, key: string, value: number): void {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, String(value));
}

/** The next facts to examine: new ones oldest first, then the backlog newest first. */
function nextBatch(db: InstanceType<typeof Database>, budget: number): Array<{ fact: RetainedFact; fresh: boolean }> {
  const maxId = (db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM facts").get() as { m: number }).m;
  let newest = readMark(db, NEWEST_SEEN);
  if (newest === null) {
    // First run: everything stored is backlog.
    newest = maxId;
    writeMark(db, NEWEST_SEEN, maxId);
    writeMark(db, BACKLOG_BELOW, maxId + 1);
  }
  const below = readMark(db, BACKLOG_BELOW) ?? 0;
  const fresh = db.prepare("SELECT * FROM facts WHERE id > ? AND valid_to IS NULL ORDER BY id ASC LIMIT ?")
    .all(newest, budget) as Array<Record<string, unknown>>;
  const backlog = db.prepare("SELECT * FROM facts WHERE id < ? AND valid_to IS NULL ORDER BY id DESC LIMIT ?")
    .all(below, budget - fresh.length) as Array<Record<string, unknown>>;
  return [
    ...fresh.map((r) => ({ fact: rowToFact(r), fresh: true })),
    ...backlog.map((r) => ({ fact: rowToFact(r), fresh: false })),
  ];
}

export async function sweepSupersededFacts(
  db: InstanceType<typeof Database>,
  hasFts: boolean,
  resolve: Resolve,
  budget: number,
  userNames: string[] = [],
): Promise<SweepResult> {
  const result: SweepResult = { examined: 0, ended: [], replacing: [], backlogLeft: false };
  const factById = db.prepare("SELECT * FROM facts WHERE id = ?");
  for (const { fact, fresh } of nextBatch(db, budget)) {
    const id = fact.id!;
    const stillCurrent = (factById.get(id) as { valid_to: number | null } | undefined)?.valid_to == null;
    if (stillCurrent) {
      result.examined++;
      const candidates = findResolverCandidates(db, hasFts, fact.content, fact.entities, CANDIDATES, { olderThan: fact.timestamp, excludeId: id });
      if (candidates.length > 0) {
        const decision = await resolve(fact.content, candidates);
        if ((decision.op === "UPDATE" || decision.op === "DELETE") && decision.targetId !== undefined) {
          const ended = invalidateFact(db, decision.targetId, {
            by: "resolver",
            reason: `superseded by ${id} (sweep): ${decision.reason}`,
            replacedBy: id,
            replacing: {
              provenance: fact.provenance ?? null, sourceFile: fact.sourceFile, occurredAt: fact.occurredAt ?? null, savedAt: fact.timestamp,
              content: fact.content, entities: fact.entities, userNames,
            },
          });
          if (ended) {
            logger.info(`[memory] fact #${decision.targetId} replaced by #${id} (sweep): ${decision.reason}`);
            result.ended.push(rowToFact(factById.get(decision.targetId) as Record<string, unknown>));
            result.replacing.push(fact);
          }
        }
      }
    }
    writeMark(db, fresh ? NEWEST_SEEN : BACKLOG_BELOW, id);
  }
  const below = readMark(db, BACKLOG_BELOW) ?? 0;
  result.backlogLeft = (db.prepare("SELECT 1 FROM facts WHERE id < ? AND valid_to IS NULL LIMIT 1").get(below)) !== undefined;
  return result;
}
