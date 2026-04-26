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

import { createLogger } from "./logger.js";
import { tokenizeBasic, jaccardSimilarity as jaccardSim } from "./memory/text-utils.js";
const logger = createLogger("memory-consolidation");

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

const LAX_DIR = join(homedir(), ".lax");
const MEMORY_DIR = join(LAX_DIR, "memory");
const ENTITIES_DIR = join(MEMORY_DIR, "bank", "entities");
const MIND_PATH = join(MEMORY_DIR, "MIND.md");
const LOG_PATH = join(LAX_DIR, "consolidation-log.json");

function ensureDirs(): void {
  for (const dir of [LAX_DIR, MEMORY_DIR, join(MEMORY_DIR, "bank"), ENTITIES_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function jaccardSimilarity(a: string, b: string): number {
  return jaccardSim(tokenizeBasic(a), tokenizeBasic(b));
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

  /**
   * One-shot scrub of MIND.md to remove chat-transcript lines that shouldn't
   * be there. Strategic Memory should hold curated facts, not raw User:/Agent:
   * turns. Idempotent — a clean file passes through untouched.
   *
   * Called on startup. The consolidator now also rejects transcript lines at
   * parse time so pollution doesn't re-accumulate.
   */
  scrubMindFile(): { linesRemoved: number; linesKept: number } {
    if (!existsSync(MIND_PATH)) return { linesRemoved: 0, linesKept: 0 };
    const original = readFileSync(MIND_PATH, "utf-8");
    const lines = original.split(/\r?\n/);
    const kept: string[] = [];
    let removed = 0;
    for (const line of lines) {
      // Strip chat-transcript shaped bullet entries
      if (/^\s*-\s*\[(?:chat|ide|session|tg|cron|wa)-[A-Za-z0-9_-]+\]\s+(User|Agent):/i.test(line)) { removed++; continue; }
      if (/^\s*-\s*(User|Agent):\s/i.test(line)) { removed++; continue; }
      if (/^\s*-\s*User (?:said|asked|wrote|shared|sent|told|replied)/i.test(line)) { removed++; continue; }
      kept.push(line);
    }
    if (removed === 0) return { linesRemoved: 0, linesKept: kept.length };
    // Collapse any run of 3+ blank lines down to 2
    const collapsed = kept.join("\n").replace(/\n{3,}/g, "\n\n");
    writeFileSync(MIND_PATH, collapsed, "utf-8");
    return { linesRemoved: removed, linesKept: kept.length };
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
      const trimmed = fact.trim();
      // Last-line-of-defense: refuse to write chat-transcript snippets into
      // strategic memory even if they slipped past every earlier filter.
      if (/^\[(?:chat|ide|session|tg|cron|wa)-[A-Za-z0-9_-]+\]/i.test(trimmed)) continue;
      if (/^(User|Agent):\s/i.test(trimmed)) continue;
      if (/^User (?:said|asked|wrote|shared|sent|told|replied)/i.test(trimmed)) continue;
      // Skip if already present
      if (mindContent.includes(trimmed)) continue;
      newLines.push(`- ${trimmed}`);
    }

    if (newLines.length === 0) return;

    const section = `\n\n## Consolidated (${todayDateStr()})\n${newLines.join("\n")}\n`;
    writeFileSync(MIND_PATH, mindContent + section, "utf-8");

    // Write-through: MIND.md just changed, push the new chunks into search.
    // Fire-and-forget so a missing universal-index never blocks consolidation.
    import("./memory/universal-index.js")
      .then(({ getUniversalIndex }) => getUniversalIndex()?.indexMindFile())
      .catch(() => {});
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
    // Try SQLite facts first (from memory_save retain), fall back to daily log parsing
    let allFacts = this.loadSqliteFacts(30);
    if (allFacts.length === 0) allFacts = this.loadAllRecentFacts(30);
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

    // Filter out operational noise — action confirmations, tool outputs,
    // internal metadata, and any chat transcript that leaked through the
    // parser. NOT facts worth remembering long-term.
    const NOISE_PATTERNS = [
      /^\[chat-[a-z0-9-]+\]/i,           // Session ID prefix
      /^\[(?:ide|session|tg|cron|wa)-[a-z0-9-]+\]/i, // Other session-id prefixes
      /^Agent:/i,                         // Agent response logs
      /^User:/i,                          // Raw user message captured as fact
      /^User (?:said|asked|wrote|shared|sent|told|replied)/i, // "User shared: ..." style capture
      /\b(pinned|unpinned|removed|added|switched|flipped|done)\b.*\b(sidebar|theme|light|dark|mode)\b/i,  // UI action confirmations
      /\b(BLOCKED|Tool result|INJECTION WARNING|EXTERNAL_UNTRUSTED)/i,  // Tool/security noise
      /^User introduced themselves/i,     // Redundant — already in USER.md
      /\b(renamed to|gayatron|shiiit)\b/i, // Test/garbage names
      /\brestarting\b/i,                  // Server restarts
    ];

    const candidates: FactEntry[] = [];
    for (const [idx, count] of occurrences) {
      if (count >= 3 && !mindContent.includes(allFacts[idx].content.trim())) {
        const text = allFacts[idx].content;
        const isNoise = NOISE_PATTERNS.some(p => p.test(text));
        if (!isNoise) {
          candidates.push(allFacts[idx]);
        }
      }
    }

    return candidates;
  }

  // ── Private helpers ───────────────────────────────────────

  private loadSqliteFacts(days: number): FactEntry[] {
    try {
      const Database = require("better-sqlite3");
      const dbPath = join(LAX_DIR, "memory.db");
      if (!existsSync(dbPath)) return [];
      const db = new Database(dbPath, { readonly: true });
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const rows = db.prepare("SELECT content, entities, confidence, timestamp FROM facts WHERE timestamp > ? ORDER BY timestamp DESC").all(cutoff) as Array<{ content: string; entities: string; confidence: number; timestamp: number }>;
      db.close();
      return rows.map(r => ({
        content: r.content,
        entity: (() => { try { const e = JSON.parse(r.entities); return Array.isArray(e) && e.length > 0 ? e[0] : undefined; } catch { return undefined; } })(),
        confidence: r.confidence,
        accessCount: 1,
        createdAt: r.timestamp,
      }));
    } catch {
      return [];
    }
  }

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

      // A fact is a structured entry written by the memory-save path. It has
      // EITHER a kind marker (W/B/O/S) optionally with a confidence tag,
      // OR an explicit `(c=X)` confidence marker somewhere in the line.
      // Lines without either are chat transcript or log noise — skip them,
      // otherwise a raw user message like "add X to sidebar" becomes a
      // "fact" with default 0.5 confidence and gets promoted to MIND.md.
      const withoutTimestamp = trimmed.replace(/^\[[\d:]+\s*(?:AM|PM)?\]\s*/, "");
      const afterChatTag = withoutTimestamp.replace(/^\[(?:chat|ide|session|tg|cron|wa)-[A-Za-z0-9_-]+\]\s*/, "");
      const hasKindPrefix = /^[WBOS](?:\(c=[\d.]+\))?\s/.test(afterChatTag);
      const hasConfidenceMarker = /\(c=(\d+\.?\d*)\)/.test(trimmed);
      if (!hasKindPrefix && !hasConfidenceMarker) continue;

      // Reject transcript tags that slipped in anyway
      if (/^(User|Agent):\s/i.test(afterChatTag)) continue;

      // Extract entity from @mentions
      const entityMatch = trimmed.match(/@([\w-]+)/);
      const entity = entityMatch ? entityMatch[1] : undefined;

      // Extract confidence if present
      const confMatch = trimmed.match(/\(c=(\d+\.?\d*)\)/);
      const confidence = confMatch ? parseFloat(confMatch[1]) : 0.5;

      // Clean content — strip timestamps, chat-id tags, kind prefix, @mentions
      const content = trimmed
        .replace(/^\[[\d:]+\s*(?:AM|PM)?\]\s*/, "")
        .replace(/^\[(?:chat|ide|session|tg|cron|wa)-[A-Za-z0-9_-]+\]\s*/, "")
        .replace(/^[WBOS](?:\(c=[\d.]+\))?\s*/, "")
        .replace(/@[\w-]+:?\s*/g, "")
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
    const touchedSlugs: string[] = [];
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
      touchedSlugs.push(slug);
    }

    // Write-through reindex for every entity page that changed. Fire-and-
    // forget so consolidation never blocks on the embedding pipeline.
    if (touchedSlugs.length > 0) {
      import("./memory/universal-index.js")
        .then(({ getUniversalIndex }) => {
          const ui = getUniversalIndex();
          if (!ui) return;
          for (const s of touchedSlugs) ui.indexEntityPage(s).catch(() => {});
        })
        .catch(() => {});
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
