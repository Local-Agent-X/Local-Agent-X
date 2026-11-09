/**
 * Undo one memory change from the change log (fact-events.ts). Each undo is
 * itself a change, logged as the actor that asked for it, so an undo can be
 * undone too.
 *
 * - end: the fact is current again. What replaced it stays current; the result
 *   names it so the user can decide about it.
 * - delete: the row comes back as it was, with its keyword and topic links.
 * - change: the changed fields go back to what they were.
 * - create: the fact is ended (not deleted).
 * - reopen: the fact is ended again.
 */
import type Database from "better-sqlite3";
import { slugify } from "./utils.js";
import { getFactEvent, withFactActor, type FactEvent } from "./fact-events.js";

type Db = InstanceType<typeof Database>;

export interface UndoResult {
  ok: boolean;
  message: string;
  factId?: number;
  /** Topics whose pages show this fact, to rebuild after the undo. */
  entities: string[];
}

const fail = (message: string): UndoResult => ({ ok: false, message, entities: [] });

function entitiesOf(row: Record<string, unknown> | null): string[] {
  try { return row ? JSON.parse(String(row.entities ?? "[]")) as string[] : []; } catch { return []; }
}

function relink(db: Db, hasFts: boolean, id: number, content: string, entities: string[]): void {
  db.prepare("DELETE FROM entity_mentions WHERE fact_id = ?").run(id);
  const mention = db.prepare("INSERT OR IGNORE INTO entity_mentions (fact_id, entity_slug) VALUES (?, ?)");
  for (const e of entities) { const s = slugify(e); if (s) mention.run(id, s); }
  if (!hasFts) return;
  try { db.prepare("DELETE FROM facts_fts WHERE rowid = ?").run(id); } catch { /* not indexed */ }
  db.prepare("INSERT INTO facts_fts (rowid, content) VALUES (?, ?)").run(id, content);
}

function end(db: Db, id: number, reason: string): boolean {
  const now = Date.now();
  return db.prepare("UPDATE facts SET valid_to = ?, invalidated_by = NULL, invalidation_reason = ?, last_updated = ? WHERE id = ? AND valid_to IS NULL")
    .run(now, reason, now, id).changes > 0;
}

function reopen(db: Db, ev: FactEvent): UndoResult {
  const current = db.prepare("SELECT valid_to, invalidated_by, content FROM facts WHERE id = ?").get(ev.factId) as
    { valid_to: number | null; invalidated_by: number | null; content: string } | undefined;
  if (!current) return fail(`memory #${ev.factId} no longer exists`);
  if (current.valid_to == null) return fail(`memory #${ev.factId} is already current`);
  try {
    db.prepare("UPDATE facts SET valid_to = NULL, invalidated_by = NULL, invalidation_reason = NULL, last_updated = ? WHERE id = ?")
      .run(Date.now(), ev.factId);
  } catch (e) {
    if ((e as Error).message.includes("UNIQUE")) return fail(`an identical memory is already current, so #${ev.factId} was left as it is`);
    throw e;
  }
  const by = current.invalidated_by != null
    ? db.prepare("SELECT id, content, valid_to FROM facts WHERE id = ?").get(current.invalidated_by) as { id: number; content: string; valid_to: number | null } | undefined
    : undefined;
  const replaced = by && by.valid_to == null ? ` Memory #${by.id} ("${by.content.slice(0, 120)}"), which had replaced it, is still current too.` : "";
  return { ok: true, factId: ev.factId, message: `Memory #${ev.factId} is current again: "${current.content.slice(0, 160)}".${replaced}`, entities: entitiesOf(ev.before) };
}

function restoreDeleted(db: Db, hasFts: boolean, ev: FactEvent): UndoResult {
  if (!ev.before) return fail(`memory #${ev.factId} was erased at your request; there is nothing to restore`);
  if (db.prepare("SELECT 1 FROM facts WHERE id = ?").get(ev.factId)) return fail(`memory #${ev.factId} already exists`);
  const columns = (db.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>).map((c) => c.name).filter((c) => c in ev.before!);
  try {
    db.prepare(`INSERT INTO facts (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...columns.map((c) => ev.before![c] as never));
  } catch (e) {
    if ((e as Error).message.includes("UNIQUE")) return fail(`an identical memory is already current, so #${ev.factId} was not brought back`);
    throw e;
  }
  const entities = entitiesOf(ev.before);
  relink(db, hasFts, ev.factId, String(ev.before.content), entities);
  return { ok: true, factId: ev.factId, message: `Memory #${ev.factId} is back: "${String(ev.before.content).slice(0, 160)}".`, entities };
}

function revertChange(db: Db, hasFts: boolean, ev: FactEvent): UndoResult {
  if (!ev.before || !ev.after) return fail(`change #${ev.id} has no record of what it changed`);
  const fields = Object.keys(ev.before).filter((k) => k !== "id" && JSON.stringify(ev.before![k]) !== JSON.stringify(ev.after![k]));
  if (fields.length === 0) return fail(`change #${ev.id} changed nothing`);
  if (!db.prepare("SELECT 1 FROM facts WHERE id = ?").get(ev.factId)) return fail(`memory #${ev.factId} no longer exists`);
  db.prepare(`UPDATE facts SET ${fields.map((f) => `${f} = ?`).join(", ")} WHERE id = ?`).run(...fields.map((f) => ev.before![f] as never), ev.factId);
  const entities = [...new Set([...entitiesOf(ev.before), ...entitiesOf(ev.after)])];
  relink(db, hasFts, ev.factId, String(ev.before.content), entitiesOf(ev.before));
  return { ok: true, factId: ev.factId, message: `Memory #${ev.factId} is back to: "${String(ev.before.content).slice(0, 160)}".`, entities };
}

export function undoFactEvent(db: Db, hasFts: boolean, eventId: number, actor: string): UndoResult {
  const ev = getFactEvent(db, eventId);
  if (!ev) return fail(`no memory change #${eventId}`);
  if (ev.undoneBy != null) return fail(`change #${eventId} was already undone`);
  return withFactActor(db, actor, () => {
    let result: UndoResult;
    if (ev.op === "end") result = reopen(db, ev);
    else if (ev.op === "delete") result = restoreDeleted(db, hasFts, ev);
    else if (ev.op === "change") result = revertChange(db, hasFts, ev);
    else {
      const ended = end(db, ev.factId, `undid change #${ev.id} (${ev.op})`);
      result = ended
        ? { ok: true, factId: ev.factId, message: `Memory #${ev.factId} is no longer current (kept as history).`, entities: entitiesOf(ev.after) }
        : fail(`memory #${ev.factId} is not current`);
    }
    if (result.ok) {
      const latest = db.prepare("SELECT MAX(id) AS id FROM fact_events WHERE fact_id = ?").get(ev.factId) as { id: number };
      db.prepare("UPDATE fact_events SET undone_by = ? WHERE id = ?").run(latest.id, ev.id);
    }
    return result;
  });
}
