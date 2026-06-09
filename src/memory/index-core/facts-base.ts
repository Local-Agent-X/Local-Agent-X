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
import { scoreFact, type ImportanceScore } from "../cognitive/importance/index.js";

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

  retain(text: string, sourceFile: string, sourceLine = 0): RetainedFact[] {
    return Facts.retain(this.db, this.hasFts, text, sourceFile, sourceLine);
  }

  async retainSmart(
    text: string,
    sourceFile: string,
    sourceLine = 0,
    opts?: { candidateLimit?: number; resolverOpts?: { provider?: "ollama" | "anthropic" | "openai" | "auto"; model?: string } }
  ): Promise<{ facts: RetainedFact[]; decisions: Array<{ content: string; op: string; targetId?: number; reason: string }> }> {
    return Facts.retainSmart(this.db, this.hasFts, text, sourceFile, sourceLine, opts);
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

  invalidateFact(id: number, opts?: { reason?: string; replacedBy?: number; at?: Date }): boolean {
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
    opts?: { kind?: FactKind; confidence?: number; sourceFile?: string }
  ): FactsMutate.OneFactResult {
    return FactsMutate.rememberFact(this.db, this.hasFts, content, opts);
  }

  updateFact(
    query: string,
    newContent: string,
    opts?: { kind?: FactKind; confidence?: number; sourceFile?: string }
  ): FactsMutate.OneFactResult {
    return FactsMutate.updateFact(this.db, this.hasFts, query, newContent, opts);
  }

  forgetFact(query: string): FactsMutate.OneFactResult {
    return FactsMutate.forgetFact(this.db, query);
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
