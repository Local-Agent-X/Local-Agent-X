import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { FactKind, RetainedFact } from "./types.js";
import { atomicWriteFileSync, slugify } from "./utils.js";
import { recallByEntity } from "./index-facts.js";
import { localDate } from "./retrieval-format.js";
import { factTrustSuffix } from "./fact-provenance-label.js";

export const MAX_FACTS_PER_ENTITY = 50;
export const MAX_FACTS_PER_KIND = 15;

export function forgetFacts(
  db: InstanceType<typeof Database>,
  hasFts: boolean,
  entitiesDir: string,
  setDirty: () => void,
  reindexEntity: (slug: string) => void,
  pattern: string
): number {
  const facts = db.prepare("SELECT id, content FROM facts WHERE content LIKE ?").all(`%${pattern}%`) as Array<{ id: number; content: string }>;
  const affectedEntities = new Set<string>();
  for (const f of facts) {
    const mentions = db.prepare("SELECT entity_slug FROM entity_mentions WHERE fact_id = ?").all(f.id) as Array<{ entity_slug: string }>;
    for (const m of mentions) affectedEntities.add(m.entity_slug);
    db.prepare("DELETE FROM entity_mentions WHERE fact_id = ?").run(f.id);
    if (hasFts) try { db.prepare("DELETE FROM facts_fts WHERE rowid = ?").run(f.id); } catch {}
    const hash = createHash("sha256").update(f.content).digest("hex");
    try { db.prepare("DELETE FROM embedding_cache WHERE hash = ?").run(hash); } catch {}
    db.prepare("DELETE FROM facts WHERE id = ?").run(f.id);
  }
  for (const slug of affectedEntities) {
    const remaining = recallByEntity(db, slug, MAX_FACTS_PER_ENTITY);
    if (remaining.length > 0) {
      updateEntityPage(db, entitiesDir, setDirty, reindexEntity, slug, remaining);
    } else {
      const entityPath = join(entitiesDir, `${slug}.md`);
      try { unlinkSync(entityPath); } catch {}
    }
  }
  return facts.length;
}

export function findFacts(
  db: InstanceType<typeof Database>,
  pattern: string
): Array<{ id: number; content: string; entities: string[] }> {
  const rows = db.prepare("SELECT id, content, entities FROM facts WHERE content LIKE ?").all(`%${pattern}%`) as Array<{ id: number; content: string; entities: string }>;
  return rows.map(r => ({ id: r.id, content: r.content, entities: JSON.parse(r.entities || "[]") }));
}

function forgetChunksWhere(
  db: InstanceType<typeof Database>,
  hasFts: boolean,
  hasVec: boolean,
  pathClause: "path LIKE ?" | "path = ?",
  pathArg: string
): number {
  const run = db.transaction(() => {
    const chunks = db.prepare(`SELECT id, hash FROM chunks WHERE ${pathClause}`).all(pathArg) as Array<{ id: number; hash: string }>;
    for (const c of chunks) {
      if (hasFts) try { db.prepare("DELETE FROM chunks_fts WHERE rowid = ?").run(c.id); } catch {}
      if (hasVec) try { db.prepare("DELETE FROM chunks_vec WHERE chunk_id = ?").run(c.id); } catch {}
      try { db.prepare("DELETE FROM embedding_cache WHERE hash = ?").run(c.hash); } catch {}
    }
    db.prepare(`DELETE FROM chunks WHERE ${pathClause}`).run(pathArg);
    db.prepare(`DELETE FROM files WHERE ${pathClause}`).run(pathArg);
    return chunks.length;
  });
  return run();
}

/** Delete every chunk whose path CONTAINS `pathPattern` (the documented
 *  `path` pattern scope — 'import/chatgpt' clears a whole import source). */
export function forgetChunks(
  db: InstanceType<typeof Database>,
  hasFts: boolean,
  hasVec: boolean,
  pathPattern: string
): number {
  return forgetChunksWhere(db, hasFts, hasVec, "path LIKE ?", `%${pathPattern}%`);
}

/** Delete the chunks of exactly ONE indexed path — a search hit's path.
 *  Never widens to siblings that merely contain it (`notes/a.md.bak`,
 *  `x/notes/a.md`). */
export function forgetChunksAtPath(
  db: InstanceType<typeof Database>,
  hasFts: boolean,
  hasVec: boolean,
  path: string
): number {
  return forgetChunksWhere(db, hasFts, hasVec, "path = ?", path);
}

export function forgetConversation(
  db: InstanceType<typeof Database>,
  hasFts: boolean,
  hasVec: boolean,
  conversationId: string
): number {
  const deleted = forgetChunks(db, hasFts, hasVec, conversationId);
  db.prepare("DELETE FROM conversation_ingest_log WHERE conversation_id = ?").run(conversationId);
  return deleted;
}

export function countChunks(
  db: InstanceType<typeof Database>,
  pathPattern: string
): number {
  return (db.prepare("SELECT COUNT(*) as c FROM chunks WHERE path LIKE ?").get(`%${pathPattern}%`) as { c: number }).c;
}

export function updateEntityPage(
  db: InstanceType<typeof Database>,
  entitiesDir: string,
  setDirty: () => void,
  reindexEntity: (slug: string) => void,
  slug: string,
  recentFacts: RetainedFact[]
): void {
  const allFacts = recallByEntity(db, slug, MAX_FACTS_PER_ENTITY);
  const displayName =
    recentFacts[0]?.entities.find((e) => slugify(e) === slug) || slug;

  const byKind = new Map<FactKind, RetainedFact[]>();
  for (const fact of allFacts) {
    if (!byKind.has(fact.kind)) byKind.set(fact.kind, []);
    const arr = byKind.get(fact.kind)!;
    if (arr.length < MAX_FACTS_PER_KIND) {
      arr.push(fact);
    }
  }

  // "Last reflected" is a MAINTENANCE timestamp — when this page was last
  // rebuilt — and it is kept because consolidation timing is what you want when
  // debugging why recall looks the way it does. It is relabelled because it used
  // to be the only date on the page, and a reader (model or human) takes the one
  // date on a page to be the date of the thing it describes. Per-fact event
  // dates are rendered below; this line is explicitly not one of them.
  const lines: string[] = [
    `# ${displayName}`,
    "",
    `*Page rebuilt: ${localDate(Date.now())} (memory maintenance — NOT when these things happened; each fact carries its own date below)*`,
    "",
  ];

  const kindLabels: Record<FactKind, string> = {
    world: "Facts",
    experience: "Experience",
    opinion: "Opinions & Preferences",
    observation: "Observations",
  };

  for (const [kind, label] of Object.entries(kindLabels) as [FactKind, string][]) {
    const facts = byKind.get(kind);
    if (!facts || facts.length === 0) continue;

    lines.push(`## ${label}`, "");
    for (const fact of facts) {
      const conf =
        kind === "opinion" ? ` (confidence: ${fact.confidence.toFixed(2)})` : "";
      // The EVENT date when the source carried one, never the write time.
      // Falling back to `timestamp` is what made a conversation from the 22nd
      // read as having happened on the 23rd, because that is when the
      // consolidation pass that recorded it happened to run.
      const occurred = fact.occurredAt != null ? localDate(fact.occurredAt) : null;
      const recorded = localDate(fact.timestamp);
      const when = occurred !== null
        ? `*${occurred}*`
        : `*date unknown* (recorded ${recorded})`;
      // Each line keeps its source, as core memory and entity context do: this
      // page is what memory_search returns, and without the label a fact the
      // user told the agent read as untrusted text the agent could not back up
      // (qwen3.6-27b, hold-sourced-claim, 2026-10-18: searched, then "you never
      // said that") — and a fact saved from web content lost its UNTRUSTED mark.
      lines.push(`- ${fact.content}${conf} — ${when}${factTrustSuffix(fact.sourceFile)}`);
    }
    lines.push("");
  }

  const entityPath = join(entitiesDir, `${slug}.md`);
  atomicWriteFileSync(entityPath, lines.join("\n"));
  setDirty();
  reindexEntity(slug);
}

/** Format 2 labels each fact's source on the page. A page is otherwise rebuilt
 *  only when one of its facts changes, so pages written before it would keep
 *  showing facts saved from web content without their UNTRUSTED mark. */
const ENTITY_PAGE_FORMAT = "2";

/** Rebuild every existing entity page once per format change. Pages that were
 *  never written stay unwritten. Returns how many were rebuilt. */
export function rebuildEntityPagesOnce(
  db: InstanceType<typeof Database>,
  entitiesDir: string,
  setDirty: () => void,
  reindexEntity: (slug: string) => void,
): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'entity_page_format'").get() as { value: string } | undefined;
  if (row?.value === ENTITY_PAGE_FORMAT) return 0;
  const slugs = existsSync(entitiesDir)
    ? readdirSync(entitiesDir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3))
    : [];
  let rebuilt = 0;
  for (const slug of slugs) {
    const facts = recallByEntity(db, slug, 1);
    if (facts.length === 0) continue;
    updateEntityPage(db, entitiesDir, setDirty, reindexEntity, slug, facts);
    rebuilt++;
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('entity_page_format', ?)").run(ENTITY_PAGE_FORMAT);
  return rebuilt;
}
