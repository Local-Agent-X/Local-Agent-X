import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { FactKind, RetainedFact } from "./types.js";
import { atomicWriteFileSync, slugify } from "./utils.js";
import { recallByEntity } from "./index-facts.js";

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

export function forgetChunks(
  db: InstanceType<typeof Database>,
  hasFts: boolean,
  hasVec: boolean,
  pathPattern: string
): number {
  const run = db.transaction(() => {
    const chunks = db.prepare("SELECT id, hash FROM chunks WHERE path LIKE ?").all(`%${pathPattern}%`) as Array<{ id: number; hash: string }>;
    for (const c of chunks) {
      if (hasFts) try { db.prepare("DELETE FROM chunks_fts WHERE rowid = ?").run(c.id); } catch {}
      if (hasVec) try { db.prepare("DELETE FROM chunks_vec WHERE chunk_id = ?").run(c.id); } catch {}
      try { db.prepare("DELETE FROM embedding_cache WHERE hash = ?").run(c.hash); } catch {}
    }
    db.prepare("DELETE FROM chunks WHERE path LIKE ?").run(`%${pathPattern}%`);
    db.prepare("DELETE FROM files WHERE path LIKE ?").run(`%${pathPattern}%`);
    return chunks.length;
  });
  return run();
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

  const lines: string[] = [
    `# ${displayName}`,
    "",
    `*Last reflected: ${new Date().toISOString().split("T")[0]}*`,
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
      const date = new Date(fact.timestamp).toISOString().split("T")[0];
      lines.push(`- ${fact.content}${conf} — *${date}*`);
    }
    lines.push("");
  }

  const entityPath = join(entitiesDir, `${slug}.md`);
  atomicWriteFileSync(entityPath, lines.join("\n"));
  setDirty();
  reindexEntity(slug);
}
