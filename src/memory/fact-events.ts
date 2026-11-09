/**
 * The memory change log: one row per create, change, end, reopen or delete of
 * a fact, holding the row as it was before and after. SQLite triggers write
 * it, so no code path, background job, sync import or hand-run script can
 * change a fact without a record, and every change can be undone
 * (fact-undo.ts). Before this, who ended a fact and why lived only in one
 * text field and the logs, and a delete left nothing (memory audit
 * 2026-11-08: a "semaglutide" restatement ended the user's reta dose record,
 * found three days later by hand).
 *
 * Who made a change is whatever `withFactActor` set around it; a change made
 * outside one records actor NULL ("unknown"), which is itself a finding.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

type Db = InstanceType<typeof Database>;

export type FactEventOp = "create" | "change" | "end" | "reopen" | "delete";

export interface FactEvent {
  id: number;
  factId: number;
  at: number;
  op: FactEventOp;
  actor: string | null;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  undoneBy: number | null;
}

/** Milliseconds since the epoch, in SQL (unixepoch('subsec') needs 3.42). */
const NOW_MS = "CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)";

/** The columns whose change is a change to what memory says. last_updated
 *  (bumped by every recall reinforcement), evidence_for (re-added by
 *  reflection every few hours) and source_message_id (stamped just after a
 *  save) are upkeep, and logging them would bury the changes that matter. */
const MEANINGFUL = ["kind", "content", "entities", "confidence", "valid_to", "invalidated_by", "provenance", "occurred_at"];

/**
 * Create the log tables and (re)create the triggers. Run on every open: the
 * triggers copy every facts column by name, so a column a later migration
 * adds is captured from the next start without a step of its own.
 */
export function installFactEvents(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fact_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fact_id INTEGER NOT NULL,
      at INTEGER NOT NULL,
      op TEXT NOT NULL,
      actor TEXT,
      reason TEXT,
      before TEXT,
      after TEXT,
      undone_by INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_fact_events_fact ON fact_events(fact_id);
    CREATE INDEX IF NOT EXISTS idx_fact_events_at ON fact_events(at);
    CREATE TABLE IF NOT EXISTS fact_actor (id INTEGER PRIMARY KEY CHECK (id = 1), actor TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS erased_facts (identity TEXT PRIMARY KEY, at INTEGER NOT NULL);
  `);
  const columns = (db.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>).map((c) => c.name);
  if (columns.length === 0) return;
  const row = (alias: "NEW" | "OLD") => `json_object(${columns.map((c) => `'${c}', ${alias}.${c}`).join(", ")})`;
  const actor = "(SELECT actor FROM fact_actor WHERE id = 1)";
  const changed = MEANINGFUL.filter((c) => columns.includes(c)).map((c) => `OLD.${c} IS NOT NEW.${c}`).join(" OR ");
  db.transaction(() => {
    db.exec(`
      DROP TRIGGER IF EXISTS fact_events_insert;
      DROP TRIGGER IF EXISTS fact_events_update;
      DROP TRIGGER IF EXISTS fact_events_delete;
      CREATE TRIGGER fact_events_insert AFTER INSERT ON facts BEGIN
        INSERT INTO fact_events (fact_id, at, op, actor, reason, before, after)
        VALUES (NEW.id, ${NOW_MS}, 'create', ${actor}, NULL, NULL, ${row("NEW")});
      END;
      CREATE TRIGGER fact_events_update AFTER UPDATE ON facts WHEN ${changed} BEGIN
        INSERT INTO fact_events (fact_id, at, op, actor, reason, before, after)
        VALUES (NEW.id, ${NOW_MS},
          CASE WHEN OLD.valid_to IS NULL AND NEW.valid_to IS NOT NULL THEN 'end'
               WHEN OLD.valid_to IS NOT NULL AND NEW.valid_to IS NULL THEN 'reopen'
               ELSE 'change' END,
          ${actor},
          CASE WHEN OLD.valid_to IS NULL AND NEW.valid_to IS NOT NULL THEN NEW.invalidation_reason ELSE NULL END,
          ${row("OLD")}, ${row("NEW")});
      END;
      CREATE TRIGGER fact_events_delete AFTER DELETE ON facts BEGIN
        INSERT INTO fact_events (fact_id, at, op, actor, reason, before, after)
        VALUES (OLD.id, ${NOW_MS}, 'delete', ${actor}, NULL, ${row("OLD")}, NULL);
      END;
    `);
  })();
}

/**
 * Log every end made before the log existed, so it can be seen and undone
 * like a new one: dated when it happened, with the reason the row kept, and
 * the actor "earlier" (who did it was never recorded). The memory audit
 * (2026-11-08) found most of the 217 model-made retirements it sampled were
 * wrong; without this they could not be put back from Settings.
 */
export function logPastEnds(db: Db): number {
  const columns = (db.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>).map((c) => c.name);
  if (columns.length === 0) return 0;
  const row = `json_object(${columns.map((c) => `'${c}', ${c}`).join(", ")})`;
  return db.prepare(`
    INSERT INTO fact_events (fact_id, at, op, actor, reason, before, after)
    SELECT id, valid_to, 'end', 'earlier', invalidation_reason,
           json_set(${row}, '$.valid_to', NULL, '$.invalidated_by', NULL, '$.invalidation_reason', NULL), ${row}
    FROM facts
    WHERE valid_to IS NOT NULL AND id NOT IN (SELECT fact_id FROM fact_events WHERE op = 'end')
    ORDER BY valid_to`).run().changes;
}

/**
 * Run `fn` with every fact change it makes recorded as `actor`'s. Restores
 * the outer actor afterwards, so a nested call (an undo that ends a fact)
 * does not leave the rest of the outer work unattributed. With `unlessSet`,
 * an actor a caller already set wins.
 */
export function withFactActor<T>(db: Db, actor: string, fn: () => T, opts: { unlessSet?: boolean } = {}): T {
  return db.transaction(() => {
    const outer = (db.prepare("SELECT actor FROM fact_actor WHERE id = 1").get() as { actor: string } | undefined)?.actor;
    // A primitive (invalidateFact) names itself only when no caller has said
    // who is acting: "sweep" says more than "resolver".
    if (opts.unlessSet && outer !== undefined) return fn();
    db.prepare("INSERT OR REPLACE INTO fact_actor (id, actor) VALUES (1, ?)").run(actor);
    try {
      return fn();
    } finally {
      if (outer === undefined) db.prepare("DELETE FROM fact_actor WHERE id = 1").run();
      else db.prepare("INSERT OR REPLACE INTO fact_actor (id, actor) VALUES (1, ?)").run(outer);
    }
  })();
}

function toEvent(r: Record<string, unknown>): FactEvent {
  const parse = (v: unknown) => (typeof v === "string" ? JSON.parse(v) as Record<string, unknown> : null);
  return {
    id: r.id as number,
    factId: r.fact_id as number,
    at: r.at as number,
    op: r.op as FactEventOp,
    actor: (r.actor as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    before: parse(r.before),
    after: parse(r.after),
    undoneBy: (r.undone_by as number | null) ?? null,
  };
}

export function getFactEvent(db: Db, id: number): FactEvent | null {
  const row = db.prepare("SELECT * FROM fact_events WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? toEvent(row) : null;
}

/**
 * Changes, newest first. `ops` narrows the kind (the default leaves out
 * creates, which are as many as the facts); `factId` gives one fact's whole
 * history; `contains` matches the fact's text before or after.
 */
export function listFactEvents(db: Db, opts: { limit?: number; ops?: FactEventOp[]; factId?: number; contains?: string; beforeId?: number } = {}): FactEvent[] {
  const where: string[] = [];
  const args: unknown[] = [];
  const ops = opts.ops ?? (opts.factId != null ? undefined : ["change", "end", "reopen", "delete"]);
  if (ops) { where.push(`op IN (${ops.map(() => "?").join(",")})`); args.push(...ops); }
  if (opts.factId != null) { where.push("fact_id = ?"); args.push(opts.factId); }
  if (opts.contains) {
    where.push("(json_extract(before, '$.content') LIKE ? ESCAPE '\\' OR json_extract(after, '$.content') LIKE ? ESCAPE '\\')");
    const like = `%${opts.contains.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    args.push(like, like);
  }
  if (opts.beforeId != null) { where.push("id < ?"); args.push(opts.beforeId); }
  const sql = `SELECT * FROM fact_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
  return (db.prepare(sql).all(...args, Math.min(opts.limit ?? 50, 500)) as Array<Record<string, unknown>>).map(toEvent);
}

/** A fact's identity across machines, as sync matches it (facts-sync.ts). */
export function factIdentity(f: { kind: string; content: string; entities: string }): string {
  return createHash("sha256").update(`${f.kind}\x00${f.content}\x00${f.entities}`).digest("hex");
}

/**
 * The user asked for these facts to be erased: their log rows keep that a
 * fact was there and when it went, but not what it said, and sync is told
 * never to bring the identity back from another machine.
 */
export function eraseFactHistory(db: Db, facts: Array<{ id: number; kind: string; content: string; entities: string }>): void {
  const scrub = db.prepare("UPDATE fact_events SET before = NULL, after = NULL, reason = 'erased at the user''s request' WHERE fact_id = ?");
  const tomb = db.prepare("INSERT OR REPLACE INTO erased_facts (identity, at) VALUES (?, ?)");
  for (const f of facts) {
    scrub.run(f.id);
    tomb.run(factIdentity(f), Date.now());
  }
}

export function isErased(db: Db, f: { kind: string; content: string; entities: string }): boolean {
  return db.prepare("SELECT 1 FROM erased_facts WHERE identity = ?").get(factIdentity(f)) !== undefined;
}
