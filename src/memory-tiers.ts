/**
 * Open Agent X — Tiered Memory Storage
 *
 * Classifies memories into HOT / WARM / COLD / ARCHIVE tiers based on
 * recency and access frequency.  Searches cascade through tiers:
 * HOT first, then WARM and COLD as needed.  ARCHIVE is only searched
 * via explicit deepRecall.
 *
 * Persists tier assignments to ~/.lax/memory-tiers.json.
 * Reclassification runs daily (hookable into consolidation).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { tokenizeBasic } from "./memory/text-utils.js";

// ══════════════════════════════════════════════════════════
//  Types
// ══════════════════════════════════════════════════════════

export type Tier = "hot" | "warm" | "cold" | "archive";

export interface TierReport {
  reclassified: number;
  tierCounts: Record<Tier, number>;
}

export interface TieredSearchResult {
  content: string;
  tier: Tier;
  score: number;
  memoryId: string;
  metadata: Record<string, unknown>;
}

interface MemoryRecord {
  memoryId: string;
  content: string;
  tier: Tier;
  lastAccessed: number;
  accessCount: number;
  createdAt: number;
  importance: number;
  metadata: Record<string, unknown>;
}

interface TierData {
  records: Record<string, MemoryRecord>;
  lastReclassify: number;
}

// ══════════════════════════════════════════════════════════
//  Constants
// ══════════════════════════════════════════════════════════

const LAX_DIR = join(homedir(), ".lax");
const TIERS_FILE = join(LAX_DIR, "memory-tiers.json");
const MS_PER_DAY = 86_400_000;

const TIER_THRESHOLDS = {
  hot: { maxAgeDays: 7, minAccessCount: 5 },
  warm: { maxAgeDays: 30, minAccessCount: 2 },
  cold: { maxAgeDays: 90, minAccessCount: 0 },
  // archive: everything older than 90 days with no access in 60 days
} as const;

// ══════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════

function scoreMatch(query: string, content: string): number {
  const qTokens = new Set(tokenizeBasic(query));
  const cTokens = new Set(tokenizeBasic(content));
  if (qTokens.size === 0 || cTokens.size === 0) return 0;

  let hits = 0;
  for (const t of qTokens) {
    if (cTokens.has(t)) hits++;
  }
  return hits / qTokens.size;
}

// ══════════════════════════════════════════════════════════
//  MemoryTierManager (singleton)
// ══════════════════════════════════════════════════════════

export class MemoryTierManager {
  private static instance: MemoryTierManager;
  private data: TierData;

  private constructor() {
    if (!existsSync(LAX_DIR)) mkdirSync(LAX_DIR, { recursive: true });
    this.data = this.loadData();
  }

  static getInstance(): MemoryTierManager {
    if (!MemoryTierManager.instance) {
      MemoryTierManager.instance = new MemoryTierManager();
    }
    return MemoryTierManager.instance;
  }

  // ── Classification ────────────────────────────────────────

  classifyMemory(memory: {
    lastAccessed: number;
    accessCount: number;
    createdAt: number;
    importance: number;
  }): Tier {
    const now = Date.now();
    const daysSinceAccess = (now - memory.lastAccessed) / MS_PER_DAY;
    const daysSinceCreated = (now - memory.createdAt) / MS_PER_DAY;

    // HOT: accessed in last 7 days OR accessCount >= 5
    if (
      daysSinceAccess <= TIER_THRESHOLDS.hot.maxAgeDays ||
      memory.accessCount >= TIER_THRESHOLDS.hot.minAccessCount
    ) {
      return "hot";
    }

    // WARM: accessed in last 30 days OR accessCount >= 2
    if (
      daysSinceAccess <= TIER_THRESHOLDS.warm.maxAgeDays ||
      memory.accessCount >= TIER_THRESHOLDS.warm.minAccessCount
    ) {
      return "warm";
    }

    // COLD: accessed in last 90 days
    if (daysSinceAccess <= TIER_THRESHOLDS.cold.maxAgeDays) {
      return "cold";
    }

    // ARCHIVE: older than 90 days, not accessed in 60+ days
    const daysSinceLastAccess = (now - memory.lastAccessed) / MS_PER_DAY;
    if (daysSinceCreated > 90 && daysSinceLastAccess > 60) {
      return "archive";
    }

    return "cold";
  }

  // ── Reclassify all memories ───────────────────────────────

  reclassifyAll(): TierReport {
    let reclassified = 0;
    const tierCounts: Record<Tier, number> = { hot: 0, warm: 0, cold: 0, archive: 0 };

    for (const record of Object.values(this.data.records)) {
      const newTier = this.classifyMemory({
        lastAccessed: record.lastAccessed,
        accessCount: record.accessCount,
        createdAt: record.createdAt,
        importance: record.importance,
      });

      if (newTier !== record.tier) {
        record.tier = newTier;
        reclassified++;
      }

      tierCounts[record.tier]++;
    }

    this.data.lastReclassify = Date.now();
    this.persist();

    return { reclassified, tierCounts };
  }

  // ── Tiered search (cascading) ─────────────────────────────

  searchTiered(query: string, maxResults = 10): TieredSearchResult[] {
    const results: TieredSearchResult[] = [];
    const tiers: Tier[] = ["hot", "warm", "cold"];

    for (const tier of tiers) {
      const tierRecords = Object.values(this.data.records).filter(
        (r) => r.tier === tier
      );

      for (const record of tierRecords) {
        const score = scoreMatch(query, record.content);
        if (score > 0.1) {
          results.push({
            content: record.content,
            tier: record.tier,
            score,
            memoryId: record.memoryId,
            metadata: record.metadata,
          });

          // Update access tracking
          record.lastAccessed = Date.now();
          record.accessCount++;
        }
      }

      // If we have enough results from higher tiers, stop cascading
      const sorted = results.sort((a, b) => b.score - a.score);
      if (sorted.length >= 3 && tier !== "cold") {
        break;
      }
    }

    this.persist();
    return results.sort((a, b) => b.score - a.score).slice(0, maxResults);
  }

  // ── Deep recall (all tiers including archive) ─────────────

  deepRecall(query: string): TieredSearchResult[] {
    const results: TieredSearchResult[] = [];

    for (const record of Object.values(this.data.records)) {
      const score = scoreMatch(query, record.content);
      if (score > 0.05) {
        results.push({
          content: record.content,
          tier: record.tier,
          score,
          memoryId: record.memoryId,
          metadata: record.metadata,
        });

        record.lastAccessed = Date.now();
        record.accessCount++;
      }
    }

    this.persist();
    return results.sort((a, b) => b.score - a.score);
  }

  // ── Stats ─────────────────────────────────────────────────

  getTierStats(): { hot: number; warm: number; cold: number; archive: number } {
    const stats = { hot: 0, warm: 0, cold: 0, archive: 0 };
    for (const record of Object.values(this.data.records)) {
      stats[record.tier]++;
    }
    return stats;
  }

  // ── Force promote to hot ──────────────────────────────────

  promoteToHot(memoryId: string): void {
    const record = this.data.records[memoryId];
    if (!record) return;

    record.tier = "hot";
    record.lastAccessed = Date.now();
    record.accessCount = Math.max(record.accessCount, TIER_THRESHOLDS.hot.minAccessCount);
    this.persist();
  }

  // ── Add / update a memory record ──────────────────────────

  addMemory(
    memoryId: string,
    content: string,
    metadata: Record<string, unknown> = {}
  ): void {
    const existing = this.data.records[memoryId];
    if (existing) {
      existing.content = content;
      existing.lastAccessed = Date.now();
      existing.accessCount++;
      existing.metadata = { ...existing.metadata, ...metadata };
    } else {
      const now = Date.now();
      this.data.records[memoryId] = {
        memoryId,
        content,
        tier: "hot",
        lastAccessed: now,
        accessCount: 1,
        createdAt: now,
        importance: (metadata.importance as number) || 0.5,
        metadata,
      };
    }
    this.persist();
  }

  // ── Remove a memory ───────────────────────────────────────

  removeMemory(memoryId: string): boolean {
    if (this.data.records[memoryId]) {
      delete this.data.records[memoryId];
      this.persist();
      return true;
    }
    return false;
  }

  // ── Persistence ───────────────────────────────────────────

  private loadData(): TierData {
    try {
      if (existsSync(TIERS_FILE)) {
        return JSON.parse(readFileSync(TIERS_FILE, "utf-8"));
      }
    } catch {
      // Corrupt file — start fresh
    }
    return { records: {}, lastReclassify: 0 };
  }

  private persist(): void {
    writeFileSync(TIERS_FILE, JSON.stringify(this.data, null, 2), "utf-8");
  }
}
