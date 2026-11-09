/**
 * Daily snapshots of the part of memory nothing can rebuild, and the restore
 * that uses them.
 *
 * memory.db is mostly derived: chunks, their keyword and vector indexes and
 * the embedding cache are rebuilt from the files on disk. The facts, their
 * change log, the record of what the user erased and the topic links exist
 * nowhere else, and sync skips the database. Before this, a database that
 * failed to open was moved aside and an empty one created: memory started
 * over with no word to the user (memory audit 2026-11-08, finding 1).
 *
 * A snapshot is a SQLite file holding those tables, read in one transaction
 * so it is consistent, checked (quick_check and a row count), then gzipped:
 * 33 MB of facts (mostly repeated evidence lists) is 1.7 MB on disk. Reading every row is also the integrity
 * check of the live tables that matter: a corrupt page there fails the copy.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { installFactEvents } from "./fact-events.js";

type Db = InstanceType<typeof Database>;

const KEEP_DAILY = 14;
const KEEP_MONTHLY = 12;
/** In dependency order: facts before the rows that point at them. */
const TABLES = ["facts", "fact_events", "erased_facts", "entity_mentions", "entity_relations"] as const;
const NAME = /^memory-facts-(\d{4}-\d{2}-\d{2})\.db\.gz$/;

export type SnapshotResult =
  | { status: "written"; path: string; facts: number }
  | { status: "exists"; path: string }
  | { status: "failed"; error: string };

/** Beside memory.db, in the data dir. */
export function snapshotDir(db: Db): string {
  const dataDir = dirname(db.name);
  return join(dataDir, "memory-backups");
}

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function schemaOf(db: Db): string[] {
  const placeholders = TABLES.map(() => "?").join(",");
  return (db.prepare(`SELECT sql FROM sqlite_master WHERE tbl_name IN (${placeholders}) AND type IN ('table', 'index') AND sql IS NOT NULL ORDER BY type DESC`)
    .all(...TABLES) as Array<{ sql: string }>).map((r) => r.sql);
}

/** A snapshot that opens, passes quick_check and holds `facts` rows (any, if undefined). */
function checkSnapshot(path: string, facts?: number): string | null {
  let snap: Db | null = null;
  try {
    snap = new Database(path, { readonly: true, fileMustExist: true });
    const check = (snap.pragma("quick_check") as Array<{ quick_check: string }>)[0]?.quick_check;
    if (check !== "ok") return `quick_check: ${check}`;
    const n = (snap.prepare("SELECT COUNT(*) AS n FROM facts").get() as { n: number }).n;
    if (facts !== undefined && n !== facts) return `holds ${n} facts, expected ${facts}`;
    if (facts === undefined && n === 0) return "holds no facts";
    return null;
  } catch (e) {
    return (e as Error).message;
  } finally {
    snap?.close();
  }
}

/** Write today's snapshot unless it exists, then prune old ones. */
export function snapshotFacts(db: Db, now = new Date()): SnapshotResult {
  const dir = snapshotDir(db);
  const path = join(dir, `memory-facts-${day(now)}.db.gz`);
  if (existsSync(path)) return { status: "exists", path };
  const tmp = join(dir, `memory-facts-${day(now)}.db.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    if (existsSync(tmp)) unlinkSync(tmp);
    const snap = new Database(tmp);
    let facts = 0;
    try {
      // The snapshot has no chunks table for entity_relations to point at.
      snap.pragma("foreign_keys = OFF");
      for (const sql of schemaOf(db)) snap.exec(sql);
      snap.prepare("ATTACH DATABASE ? AS live").run(db.name);
      snap.transaction(() => {
        for (const t of TABLES) {
          if (snap.prepare("SELECT 1 FROM live.sqlite_master WHERE name = ?").get(t)) snap.exec(`INSERT INTO main.${t} SELECT * FROM live.${t}`);
        }
        facts = (snap.prepare("SELECT COUNT(*) AS n FROM live.facts").get() as { n: number }).n;
      })();
      snap.exec("DETACH DATABASE live");
    } finally {
      snap.close();
    }
    const bad = checkSnapshot(tmp, facts);
    if (bad) { unlinkSync(tmp); return { status: "failed", error: bad }; }
    writeFileSync(`${path}.part`, gzipSync(readFileSync(tmp)));
    renameSync(`${path}.part`, path);
    unlinkSync(tmp);
    pruneSnapshots(dir);
    return { status: "written", path, facts };
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    return { status: "failed", error: (e as Error).message };
  }
}

/** Snapshot files, newest first. */
export function listSnapshots(dir: string): Array<{ path: string; day: string }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const m = NAME.exec(f);
    return m ? [{ path: join(dir, f), day: m[1] }] : [];
  }).sort((a, b) => b.day.localeCompare(a.day));
}

/** Keep the newest KEEP_DAILY, plus the newest of each of the last KEEP_MONTHLY months. */
export function pruneSnapshots(dir: string): string[] {
  const all = listSnapshots(dir);
  const keep = new Set(all.slice(0, KEEP_DAILY).map((s) => s.path));
  const months = new Set<string>();
  for (const s of all) {
    const month = s.day.slice(0, 7);
    if (months.has(month) || months.size >= KEEP_MONTHLY) continue;
    months.add(month);
    keep.add(s.path);
  }
  const removed = all.filter((s) => !keep.has(s.path)).map((s) => s.path);
  for (const p of removed) unlinkSync(p);
  return removed;
}

export interface RestoreResult { from: string; facts: number }

/**
 * Fill a database that was just recreated from the newest snapshot that
 * passes its checks. Only runs into an empty facts table: it never mixes a
 * snapshot into memory that has rows of its own. The restored rows are not
 * logged as new: their own change log comes back with them.
 */
export function restoreFacts(db: Db, hasFts: boolean): RestoreResult | null {
  if ((db.prepare("SELECT COUNT(*) AS n FROM facts").get() as { n: number }).n > 0) return null;
  const dir = snapshotDir(db);
  const unpacked = join(dir, "restoring.db");
  const good = listSnapshots(dir).find((s) => {
    try { writeFileSync(unpacked, gunzipSync(readFileSync(s.path))); } catch { return false; }
    return checkSnapshot(unpacked) === null;
  });
  if (!good) { if (existsSync(unpacked)) unlinkSync(unpacked); return null; }
  try {
    copyFacts(db, hasFts, unpacked);
  } finally {
    unlinkSync(unpacked);
  }
  const facts = (db.prepare("SELECT COUNT(*) AS n FROM facts").get() as { n: number }).n;
  return { from: good.path, facts };
}

function copyFacts(db: Db, hasFts: boolean, snapshot: string): void {
  db.pragma("foreign_keys = OFF");
  try {
    db.exec("DROP TRIGGER IF EXISTS fact_events_insert; DROP TRIGGER IF EXISTS fact_events_update; DROP TRIGGER IF EXISTS fact_events_delete;");
    db.prepare("ATTACH DATABASE ? AS snap").run(snapshot);
    try {
      db.transaction(() => {
        for (const t of TABLES) {
          if (!db.prepare("SELECT 1 FROM snap.sqlite_master WHERE name = ?").get(t)) continue;
          db.exec(`DELETE FROM main.${t}`);
          // Relations drawn from chunks come back when the chunks are re-indexed.
          db.exec(`INSERT INTO main.${t} SELECT * FROM snap.${t}${t === "entity_relations" ? " WHERE chunk_id IS NULL" : ""}`);
        }
        // facts_fts reads its text from facts: rebuild it from the rows now there.
        if (hasFts) db.exec("INSERT INTO facts_fts (facts_fts) VALUES ('rebuild')");
      })();
    } finally {
      db.exec("DETACH DATABASE snap");
    }
  } finally {
    installFactEvents(db);
    db.pragma("foreign_keys = ON");
  }
}
