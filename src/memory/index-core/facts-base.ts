/**
 * Facts / knowledge-graph surface of MemoryIndex (PRD §6).
 *
 * Pure structural lift out of index-core.ts: the retain/recall/validity,
 * single-fact agent ops, relations, reflect, and top-important ranking move
 * onto this base class so MemoryIndex stays under the 400 LOC cap. Behavior
 * and method signatures are unchanged — these are the same thin delegations
 * over ./index-facts, ./index-facts-mutate, ./index-relations, ./index-reflect
 * the class held inline. MemoryIndex extends this base and supplies the shared
 * db / hasFts / entitiesDir / dirty state and the reindex hook.
 */
import type Database from "better-sqlite3";
import type { FactKind, RetainedFact } from "../types.js";
import * as Facts from "../index-facts.js";
import * as FactsMutate from "../index-facts-mutate.js";
import * as Relations from "../index-relations.js";
import * as Reflectx from "../index-reflect.js";
import { updateEntityPage } from "../index-forget.js";
import { rowToFact, slugify } from "../utils.js";
import { scoreFact, type ImportanceScore } from "../cognitive/importance/index.js";
import type { MemoryPromotionContext } from "../promotion-gate.js";

export abstract class MemoryFactsBase {
  protected abstract db: InstanceType<typeof Database>;
  protected abstract entitiesDir: string;
  protected abstract dirty: boolean;
  protected abstract hasFts: boolean;
  protected abstract reindexThroughUniversal(
    target: "daily-log" | "entity",
    slug?: string,
  ): Promise<void>;

  // ── RETAIN ──

  retain(
    text: string,
    sourceFile: string,
    sourceLine = 0,
    promotion?: MemoryPromotionContext,
    occurredAt?: number | null,
  ): RetainedFact[] {
    return this.refreshEntityPages(Facts.retain(this.db, this.hasFts, text, sourceFile, sourceLine, promotion, occurredAt));
  }

  async retainSmart(
    text: string,
    sourceFile: string,
    sourceLine = 0,
    opts?: { candidateLimit?: number; resolverOpts?: { provider?: "ollama" | "anthropic" | "openai" | "auto"; model?: string }; promotion?: MemoryPromotionContext; occurredAt?: number | null }
  ): Promise<{ facts: RetainedFact[]; decisions: Array<{ content: string; op: string; targetId?: number; reason: string }> }> {
    const result = await Facts.retainSmart(this.db, this.hasFts, text, sourceFile, sourceLine, opts);
    this.refreshEntityPages(result.facts);
    return result;
  }

  // ── RECALL ──

  recallByEntity(entitySlug: string, limit = 20, opts?: { includeInvalidated?: boolean }): RetainedFact[] {
    return Facts.recallByEntity(this.db, entitySlug, limit, opts);
  }

  recallByKind(kind: FactKind, limit = 20, opts?: { includeInvalidated?: boolean }): RetainedFact[] {
    return Facts.recallByKind(this.db, kind, limit, opts);
  }

  recallByTime(since: Date, until?: Date, limit = 50, opts?: { includeInvalidated?: boolean }): RetainedFact[] {
    return Facts.recallByTime(this.db, since, until, limit, opts);
  }

  recallOpinions(entitySlug?: string, opts?: { includeInvalidated?: boolean }): RetainedFact[] {
    return Facts.recallOpinions(this.db, entitySlug, opts);
  }

  recallAsOf(asOf: Date, opts?: { kind?: FactKind; entitySlug?: string; limit?: number }): RetainedFact[] {
    return Facts.recallAsOf(this.db, asOf, opts);
  }

  // ── Validity ──

  invalidateFact(id: number, opts: Parameters<typeof Facts.invalidateFact>[2]): boolean {
    return Facts.invalidateFact(this.db, id, opts);
  }

  validityStats(): { valid: number; invalidated: number } {
    return Facts.validityStats(this.db);
  }

  purgeInvalidatedFacts(olderThanMs: number): number {
    return Facts.purgeInvalidatedFacts(this.db, this.hasFts, olderThanMs);
  }

  // ── Single-fact agent API (used by remember / update_fact / forget tools) ──

  rememberFact(
    content: string,
    opts?: { kind?: FactKind; confidence?: number; sourceFile?: string; promotion?: MemoryPromotionContext }
  ): FactsMutate.OneFactResult {
    const result = FactsMutate.rememberFact(this.db, this.hasFts, content, opts);
    if (result.fact) this.refreshEntityPages([result.fact]);
    return result;
  }

  updateFact(
    query: string,
    newContent: string,
    opts?: { kind?: FactKind; confidence?: number; sourceFile?: string; promotion?: MemoryPromotionContext }
  ): FactsMutate.OneFactResult {
    const result = FactsMutate.updateFact(this.db, this.hasFts, query, newContent, opts);
    if (result.fact) this.refreshEntityPages([result.fact, ...this.factsById([result.oldFactId])]);
    return result;
  }

  forgetFact(query: string): FactsMutate.OneFactResult {
    const result = FactsMutate.forgetFact(this.db, query);
    if (result.fact) this.refreshEntityPages([result.fact]);
    return result;
  }

  /**
   * Rebuild the entity page of every entity these facts name. The page is how
   * a fact reaches memory_search (search indexes text, not the facts table),
   * and it was rebuilt only by reflect or a pattern forget — so a fact saved
   * mid-chat could not be searched for until maintenance ran (qwen3:8b eval
   * 2026-10-13: memory_search "Odalys's sailboat slip" → 0 hits beside a
   * current fact). The write returns as before; pages are file writes and the
   * index picks them up on the next search's sync.
   */
  private refreshEntityPages<T extends RetainedFact[]>(facts: T): T {
    const bySlug = new Map<string, RetainedFact[]>();
    for (const fact of facts) {
      for (const entity of fact.entities) {
        const slug = slugify(entity);
        if (slug) bySlug.set(slug, [...(bySlug.get(slug) ?? []), fact]);
      }
    }
    for (const [slug, recent] of bySlug) {
      updateEntityPage(this.db, this.entitiesDir, () => { this.dirty = true; },
        (s) => { this.reindexThroughUniversal("entity", s).catch(() => {}); }, slug, recent);
    }
    return facts;
  }

  private factsById(ids: Array<number | undefined>): RetainedFact[] {
    return ids.flatMap((id) => {
      if (id === undefined) return [];
      const row = this.db.prepare("SELECT * FROM facts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      return row ? [rowToFact(row)] : [];
    });
  }

  recallRecentFacts(opts?: { kinds?: FactKind[]; minConfidence?: number; limit?: number; sinceMs?: number; halfLifeDays?: number }): RetainedFact[] {
    return FactsMutate.recallRecentFacts(this.db, opts);
  }

  reinforceFacts(ids: number[]): number {
    return FactsMutate.reinforceFacts(this.db, ids);
  }

  // The user's most important memories, highest score first. Scores the full
  // valid-fact pool (capped) and ranks by the importance formula — confidence,
  // emotional salience, richness, reinforcement, recency.
  topImportantFacts(limit = 20): Array<{ fact: RetainedFact; importance: ImportanceScore }> {
    const now = Date.now();
    return Facts.allValidFacts(this.db, 1000)
      .map((fact) => ({ fact, importance: scoreFact(fact, now) }))
      .sort((a, b) => b.importance.score - a.importance.score)
      .slice(0, Math.max(1, limit));
  }

  // ── Relations ──

  storeRelation(opts: {
    subject: string;
    predicate: string;
    object: string;
    factId?: number;
    chunkId?: number;
    confidence?: number;
  }): void {
    Relations.storeRelation(this.db, opts);
  }

  getRelationsFor(entity: string, limit = 30): Array<{ subject: string; predicate: string; object: string; factId: number | null; chunkId: number | null }> {
    return Relations.getRelationsFor(this.db, entity, limit);
  }

  traverseFrom(entity: string, maxHops = 2): Set<string> {
    return Relations.traverseFrom(this.db, entity, maxHops);
  }

  extractRelations(text: string, entities: string[], factId?: number, chunkId?: number): number {
    return Relations.extractRelations(this.db, text, entities, factId, chunkId);
  }

  relationCount(): number {
    return Relations.relationCount(this.db);
  }

  // ── Reflect ──

  async reflect(sinceDays = 7): Promise<{
    entitiesUpdated: string[];
    opinionsUpdated: number;
  }> {
    return Reflectx.reflect(
      this.db, this.entitiesDir,
      () => { this.dirty = true; },
      (slug) => { this.reindexThroughUniversal("entity", slug).catch(() => {}); },
      sinceDays,
    );
  }
}
