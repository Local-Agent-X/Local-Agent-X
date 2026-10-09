// Grading against what the run left in memory, not what the reply says about
// it. A 2026-10-08 qwen3.6:27b run answered "Got it — slip 31, I've updated
// that" without calling update_fact: graded on the reply it passed, while the
// store still said slip 14 and the next chat would have repeated it.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Content of every fact still in force (bitemporal: a superseded or
 *  forgotten fact has valid_to set). */
export function currentFacts(dataDir) {
  const path = join(dataDir, "memory.db");
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT content FROM facts WHERE valid_to IS NULL").all().map((r) => String(r.content));
  } finally {
    db.close();
  }
}

/** `factStored`: some current fact contains every `all` fragment, and no
 *  other current fact still carries a `none` fragment — the old value left in
 *  force beside the new one. A fact holding both ("moved from slip 14 to slip
 *  31") is the correction itself, not a stale copy. */
export function factStored(check, dataDir, fill) {
  const facts = currentFacts(dataDir).map((f) => f.toLowerCase());
  const all = (check.all ?? []).map((s) => fill(s).toLowerCase());
  const none = (check.none ?? []).map((s) => fill(s).toLowerCase());
  const holds = (f) => all.every((s) => f.includes(s));
  const holding = facts.find(holds);
  const stale = facts.find((f) => !holds(f) && none.some((s) => f.includes(s)));
  if (!holding) return { ok: false, detail: `no current fact contains ${all.join(" + ")} (${facts.length} current)` };
  if (stale) return { ok: false, detail: `a current fact still says "${stale.slice(0, 120)}"` };
  return { ok: true, detail: `stored: "${holding.slice(0, 120)}"` };
}
