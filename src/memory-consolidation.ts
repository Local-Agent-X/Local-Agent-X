/**
 * Open Agent X — Memory Consolidation
 *
 * Analogous to sleep consolidation in the brain: groups related facts,
 * merges duplicates, detects reinforcement, promotes important facts to
 * long-term storage (MIND.md), and updates entity pages.
 *
 * Runs nightly at 3 AM or on demand.  Persists consolidation history
 * to ~/.sax/consolidation-log.json.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ══════════════════════════════════════════════════════════
//  Types
// ══════════════════════════════════════════════════════════

export interface FactEntry {
  content: string;
  entity?: string;
  confidence: number;
  accessCount: number;
  createdAt: number;
}

export interface MergedFact {
  original: FactEntry[];
  merged: string;
  confidence: number;
}

export interface ConsolidationReport {
  mergedCount: number;
  promotedCount: number;
  entityPagesUpdated: number;
  contradictionsFound: number;
  timestamp: number;
}

interface ConsolidationLogEntry {
  report: ConsolidationReport;
  promotedFacts: string[];
  mergedPairs: Array<{ from: string[]; to: string }>;
}

// ══════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════

const SAX_DIR = join(homedir(), ".sax");
const MEMORY_DIR = join(SAX_DIR, "memory");
const ENTITIES_DIR = join(MEMORY_DIR, "bank", "entities");
const MIND_PATH = join(MEMORY_DIR, "MIND.md");
const LOG_PATH = join(SAX_DIR, "consolidation-log.json");

function ensureDirs(): void {
  for (const dir of [SAX_DIR, MEMORY_DIR, join(MEMORY_DIR, "bank"), ENTITIES_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function todayDateStr(): string {
  return new Date().toISOString().split("T")[0];
}

// ══════════════════════════════════════════════════════════
//  MemoryConsolidator (singleton)
// ══════════════════════════════════════════════════════════

export class MemoryConsolidator {
  private static instance: MemoryConsolidator;
  private history: ConsolidationLogEntry[];
  private nightlyTimer: ReturnType<typeof setTimeout> | null = null;

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
    const facts = this.loadTodayFacts();
    const grouped = this.groupByEntity(facts);
    const mergedResults: MergedFact[] = [];
    let contradictionsFound = 0;

    // Merge duplicates within each entity group
    for (const [, group] of grouped) {
      const merged = this.mergeRelatedFacts(group);
      mergedResults.push(...merged);
    }

    // Also merge ungrouped facts (no entity)
    const ungrouped = facts.filter((f) => !f.entity);
    if (ungrouped.length > 1) {
      mergedResults.push(...this.mergeRelatedFacts(ungrouped));
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
      contradictionsFound += this.countContradictions(group);
    }

    // Identify promotion candidates
    const candidates = this.getPromotionCandidates();
    const promoted = candidates.map((f) => f.content);
    if (promoted.length > 0) {
      this.promoteToLongTerm(promoted);
    }

    // Update entity pages
    const entityPagesUpdated = this.updateAllEntityPages(grouped);

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

  // ── Promote important facts to MIND.md ────────────────────

  promoteToLongTerm(facts: string[]): void {
    if (facts.length === 0) return;
    ensureDirs();

    let mindContent = "";
    if (existsSync(MIND_PATH)) {
      mindContent = readFileSync(MIND_PATH, "utf-8");
    }

    const newLines: string[] = [];
    for (const fact of facts) {
      // Skip if already present
      if (mindContent.includes(fact.trim())) continue;
      newLines.push(`- ${fact.trim()}`);
    }

    if (newLines.length === 0) return;

    const section = `\n\n## Consolidated (${todayDateStr()})\n${newLines.join("\n")}\n`;
    writeFileSync(MIND_PATH, mindContent + section, "utf-8");
  }

  // ── Merge related facts ───────────────────────────────────

  mergeRelatedFacts(facts: FactEntry[]): MergedFact[] {
    if (facts.length < 2) return [];

    const merged: MergedFact[] = [];
    const used = new Set<number>();

    for (let i = 0; i < facts.length; i++) {
      if (used.has(i)) continue;
      const group: FactEntry[] = [facts[i]];
      used.add(i);

      for (let j = i + 1; j < facts.length; j++) {
        if (used.has(j)) continue;
        const sim = jaccardSimilarity(facts[i].content, facts[j].content);
        if (sim >= 0.7) {
          group.push(facts[j]);
          used.add(j);
        }
      }

      if (group.length > 1) {
        // Keep the most detailed version (longest content)
        const best = group.reduce((a, b) =>
          a.content.length >= b.content.length ? a : b
        );
        const maxConfidence = Math.min(
          1,
          Math.max(...group.map((g) => g.confidence)) + 0.05
        );
        merged.push({
          original: group,
          merged: best.content,
          confidence: maxConfidence,
        });
      }
    }

    return merged;
  }

  // ── Promotion candidates: facts mentioned 3+ times ────────

  getPromotionCandidates(): FactEntry[] {
    const allFacts = this.loadAllRecentFacts(30);
    const mindContent = existsSync(MIND_PATH)
      ? readFileSync(MIND_PATH, "utf-8")
      : "";

    // Count similar fact occurrences
    const occurrences = new Map<number, number>();
    for (let i = 0; i < allFacts.length; i++) {
      if (occurrences.has(i)) continue;
      let count = 1;
      for (let j = i + 1; j < allFacts.length; j++) {
        if (jaccardSimilarity(allFacts[i].content, allFacts[j].content) >= 0.6) {
          count++;
          occurrences.set(j, -1); // mark as duplicate
        }
      }
      occurrences.set(i, count);
    }

    const candidates: FactEntry[] = [];
    for (const [idx, count] of occurrences) {
      if (count >= 3 && !mindContent.includes(allFacts[idx].content.trim())) {
        candidates.push(allFacts[idx]);
      }
    }

    return candidates;
  }

  // ── Schedule nightly consolidation ────────────────────────

  scheduleNightly(): void {
    if (this.nightlyTimer) {
      clearTimeout(this.nightlyTimer);
    }

    const now = new Date();
    const next3am = new Date(now);
    next3am.setHours(3, 0, 0, 0);
    if (next3am.getTime() <= now.getTime()) {
      next3am.setDate(next3am.getDate() + 1);
    }

    const delay = next3am.getTime() - now.getTime();
    this.nightlyTimer = setTimeout(() => {
      try {
        const report = this.consolidate();
        console.log(
          `[consolidation] Nightly run: merged=${report.mergedCount} promoted=${report.promotedCount} entities=${report.entityPagesUpdated}`
        );
      } catch (err) {
        console.error("[consolidation] Nightly run failed:", err);
      }
      // Reschedule for next night
      this.scheduleNightly();
    }, delay);

    // Prevent timer from keeping process alive
    if (this.nightlyTimer && typeof this.nightlyTimer === "object" && "unref" in this.nightlyTimer) {
      this.nightlyTimer.unref();
    }
  }

  // ── Private helpers ───────────────────────────────────────

  private loadTodayFacts(): FactEntry[] {
    const logPath = join(MEMORY_DIR, `${todayDateStr()}.md`);
    if (!existsSync(logPath)) return [];
    return this.parseFactsFromLog(readFileSync(logPath, "utf-8"));
  }

  private loadAllRecentFacts(days: number): FactEntry[] {
    const facts: FactEntry[] = [];
    const now = Date.now();
    const cutoff = now - days * 24 * 60 * 60 * 1000;

    if (!existsSync(MEMORY_DIR)) return facts;

    const files = readdirSync(MEMORY_DIR).filter((f) =>
      /^\d{4}-\d{2}-\d{2}\.md$/.test(f)
    );

    for (const file of files) {
      const dateStr = file.replace(".md", "");
      const fileDate = new Date(dateStr).getTime();
      if (fileDate < cutoff) continue;

      const content = readFileSync(join(MEMORY_DIR, file), "utf-8");
      facts.push(...this.parseFactsFromLog(content, fileDate));
    }

    return facts;
  }

  private parseFactsFromLog(content: string, baseTime?: number): FactEntry[] {
    const facts: FactEntry[] = [];
    const lines = content.split("\n").filter((l) => l.trim().length > 0);

    for (const line of lines) {
      const trimmed = line.trim();
      // Skip headers and empty lines
      if (trimmed.startsWith("#") || trimmed.length < 10) continue;

      // Extract entity from @mentions
      const entityMatch = trimmed.match(/@([\w-]+)/);
      const entity = entityMatch ? entityMatch[1] : undefined;

      // Extract confidence if present: (c=0.9)
      const confMatch = trimmed.match(/\(c=(\d+\.?\d*)\)/);
      const confidence = confMatch ? parseFloat(confMatch[1]) : 0.5;

      // Clean content
      const content = trimmed
        .replace(/^\[[\d:]+\s*(?:AM|PM)?\]\s*/, "") // strip timestamps
        .replace(/^[WBOS](?:\(c=[\d.]+\))?\s*/, "") // strip kind prefix
        .replace(/@[\w-]+:?\s*/g, "") // strip @mentions
        .trim();

      if (content.length < 5) continue;

      facts.push({
        content,
        entity,
        confidence,
        accessCount: 1,
        createdAt: baseTime || Date.now(),
      });
    }

    return facts;
  }

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

  private countContradictions(group: FactEntry[]): number {
    let count = 0;
    const locationPatterns = /\b(lives?\s+in|moved?\s+to|based\s+in|from)\b/i;
    const employmentPatterns = /\b(works?\s+(at|for)|job\s+is|hired\s+at|left)\b/i;
    const statusPatterns = /\b(married|single|dating)\b/i;

    const patterns = [locationPatterns, employmentPatterns, statusPatterns];

    for (const pattern of patterns) {
      const matching = group.filter((f) => pattern.test(f.content));
      if (matching.length > 1) {
        // Multiple facts about same category for same entity — potential contradiction
        for (let i = 0; i < matching.length; i++) {
          for (let j = i + 1; j < matching.length; j++) {
            const sim = jaccardSimilarity(matching[i].content, matching[j].content);
            if (sim < 0.5) count++; // Low similarity = likely contradiction
          }
        }
      }
    }

    return count;
  }

  private updateAllEntityPages(grouped: Map<string, FactEntry[]>): number {
    let updated = 0;
    for (const [slug, facts] of grouped) {
      if (facts.length === 0) continue;
      const entityPath = join(ENTITIES_DIR, `${slug}.md`);

      let existing = "";
      if (existsSync(entityPath)) {
        existing = readFileSync(entityPath, "utf-8");
      }

      const displayName = facts[0].entity || slug;
      const newFacts = facts.filter((f) => !existing.includes(f.content));
      if (newFacts.length === 0) continue;

      const additions = newFacts
        .map((f) => `- ${f.content} (c=${f.confidence.toFixed(2)})`)
        .join("\n");

      if (existing) {
        appendFileSync(
          entityPath,
          `\n\n### Consolidated ${todayDateStr()}\n${additions}\n`,
          "utf-8"
        );
      } else {
        const header = `# ${displayName}\n\n*Created: ${todayDateStr()}*\n\n### Facts\n${additions}\n`;
        writeFileSync(entityPath, header, "utf-8");
      }

      updated++;
    }
    return updated;
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
