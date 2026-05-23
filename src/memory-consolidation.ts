/**
 * Local Agent X — Memory Consolidation
 *
 * Analogous to sleep consolidation in the brain: groups related facts,
 * merges duplicates, detects reinforcement, promotes important facts to
 * long-term storage (MIND.md), and updates entity pages.
 *
 * Runs nightly at 3 AM or on demand. Persists consolidation history to
 * ~/.lax/consolidation-log.json.
 *
 * Helpers split into ./memory-consolidation/* — this file owns the
 * singleton, the consolidate() cycle, and the history persistence.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  LOG_PATH,
  type ConsolidationLogEntry,
  type ConsolidationReport,
  type FactEntry,
  type MergedFact,
} from "./memory-consolidation/types.js";
import { ensureDirs, jaccardSimilarity, slugify } from "./memory-consolidation/utils.js";
import { loadTodayFacts } from "./memory-consolidation/load-facts.js";
import { countContradictions, getPromotionCandidates, mergeRelatedFacts } from "./memory-consolidation/analyze.js";
import { promoteToLongTerm, scrubMindFile, updateAllEntityPages } from "./memory-consolidation/write.js";

export type { FactEntry, MergedFact, ConsolidationReport } from "./memory-consolidation/types.js";

export class MemoryConsolidator {
  private static instance: MemoryConsolidator;
  private history: ConsolidationLogEntry[];

  private constructor() {
    ensureDirs();
    this.history = this.loadHistory();
  }

  static getInstance(): MemoryConsolidator {
    if (!MemoryConsolidator.instance) {
      MemoryConsolidator.instance = new MemoryConsolidator();
    }
    return MemoryConsolidator.instance;
  }

  // ── Main consolidation cycle ─────────────────────────────

  consolidate(): ConsolidationReport {
    const facts = loadTodayFacts();
    const grouped = this.groupByEntity(facts);
    const mergedResults: MergedFact[] = [];
    let contradictionsFound = 0;

    // Merge duplicates within each entity group
    for (const [, group] of grouped) {
      const merged = mergeRelatedFacts(group);
      mergedResults.push(...merged);
    }

    // Also merge ungrouped facts (no entity)
    const ungrouped = facts.filter((f) => !f.entity);
    if (ungrouped.length > 1) {
      mergedResults.push(...mergeRelatedFacts(ungrouped));
    }

    // Detect reinforcing facts — increase confidence
    for (const [, group] of grouped) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const sim = jaccardSimilarity(group[i].content, group[j].content);
          if (sim > 0.3 && sim < 0.7) {
            // Reinforcing but not duplicate — boost confidence
            group[i].confidence = Math.min(1, group[i].confidence + 0.1);
            group[j].confidence = Math.min(1, group[j].confidence + 0.1);
          }
        }
      }
    }

    // Simple contradiction detection within groups
    for (const [, group] of grouped) {
      contradictionsFound += countContradictions(group);
    }

    // Identify promotion candidates
    const candidates = getPromotionCandidates();
    const promoted = candidates.map((f) => f.content);
    if (promoted.length > 0) {
      promoteToLongTerm(promoted);
    }

    // Update entity pages
    const entityPagesUpdated = updateAllEntityPages(grouped);

    const report: ConsolidationReport = {
      mergedCount: mergedResults.length,
      promotedCount: promoted.length,
      entityPagesUpdated,
      contradictionsFound,
      timestamp: Date.now(),
    };

    // Persist
    const logEntry: ConsolidationLogEntry = {
      report,
      promotedFacts: promoted,
      mergedPairs: mergedResults.map((m) => ({
        from: m.original.map((o) => o.content),
        to: m.merged,
      })),
    };
    this.history.push(logEntry);
    this.saveHistory();

    return report;
  }

  // ── Pass-through wrappers preserving the public class surface ────

  scrubMindFile(): { linesRemoved: number; linesKept: number } {
    return scrubMindFile();
  }

  promoteToLongTerm(facts: string[]): void {
    promoteToLongTerm(facts);
  }

  mergeRelatedFacts(facts: FactEntry[]): MergedFact[] {
    return mergeRelatedFacts(facts);
  }

  getPromotionCandidates(): FactEntry[] {
    return getPromotionCandidates();
  }

  // ── Private helpers ───────────────────────────────────────

  private groupByEntity(facts: FactEntry[]): Map<string, FactEntry[]> {
    const groups = new Map<string, FactEntry[]>();
    for (const fact of facts) {
      if (!fact.entity) continue;
      const key = slugify(fact.entity);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(fact);
    }
    return groups;
  }

  private loadHistory(): ConsolidationLogEntry[] {
    try {
      if (existsSync(LOG_PATH)) {
        return JSON.parse(readFileSync(LOG_PATH, "utf-8"));
      }
    } catch {
      // Corrupt file — start fresh
    }
    return [];
  }

  private saveHistory(): void {
    // Keep last 90 entries to prevent unbounded growth
    const trimmed = this.history.slice(-90);
    writeFileSync(LOG_PATH, JSON.stringify(trimmed, null, 2), "utf-8");
  }
}
