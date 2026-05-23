import { basename } from "node:path";

import type {
  ArchiveResult,
  ImportanceScore,
  MemoryEntry,
  ScoreRecord,
  ScoresData,
} from "./types.js";
import {
  DECAY_PER_DAY,
  DEFAULT_ARCHIVE_THRESHOLD,
  MS_PER_DAY,
  PROTECTED_FILES,
} from "./constants.js";
import { scoreMemory, scoreToLevel } from "./scoring.js";
import {
  ensureDirs,
  fileToEntry,
  listMemoryFiles,
  loadMemoryFiles,
  loadScores,
  moveToArchive,
  persistScores,
} from "./persistence.js";

export class MemoryImportance {
  private static instance: MemoryImportance;
  private scores: ScoresData;

  private constructor() {
    ensureDirs();
    this.scores = loadScores();
    this.runDailyDecay();
  }

  static getInstance(): MemoryImportance {
    if (!MemoryImportance.instance) {
      MemoryImportance.instance = new MemoryImportance();
    }
    return MemoryImportance.instance;
  }

  scoreMemory(memory: {
    content: string;
    createdAt: number;
    lastAccessed?: number;
    accessCount?: number;
    userFeedback?: "positive" | "negative";
  }): ImportanceScore {
    return scoreMemory(memory);
  }

  recordAccess(memoryId: string): void {
    const rec = this.getOrCreateRecord(memoryId);
    rec.accessCount += 1;
    rec.lastAccessed = Date.now();
    this.persist();
  }

  recordFeedback(memoryId: string, feedback: "positive" | "negative"): void {
    const rec = this.getOrCreateRecord(memoryId);
    rec.userFeedback = feedback;
    this.persist();
  }

  rankMemories(memories: MemoryEntry[]): MemoryEntry[] {
    const scored = memories.map((m) => ({
      memory: m,
      score: scoreMemory(m).score,
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.memory);
  }

  getArchiveCandidates(threshold?: number): MemoryEntry[] {
    const cutoff = threshold ?? DEFAULT_ARCHIVE_THRESHOLD;
    const memories = loadMemoryFiles(this.scores);
    return memories.filter((m) => {
      if (PROTECTED_FILES.has(basename(m.id))) return false;
      return scoreMemory(m).score < cutoff;
    });
  }

  autoArchive(dryRun?: boolean): ArchiveResult {
    const archived: string[] = [];
    const kept: string[] = [];

    const allFiles = listMemoryFiles();
    for (const filename of allFiles) {
      if (PROTECTED_FILES.has(filename)) {
        kept.push(filename);
        continue;
      }

      const entry = fileToEntry(filename, this.scores);
      if (!entry) {
        kept.push(filename);
        continue;
      }

      const result = scoreMemory(entry);
      if (result.score < DEFAULT_ARCHIVE_THRESHOLD) {
        if (!dryRun) {
          moveToArchive(filename, this.scores);
        }
        archived.push(filename);
      } else {
        kept.push(filename);
      }
    }

    return { archived, kept, dryRun: !!dryRun };
  }

  getImportanceStats(): {
    total: number;
    avgScore: number;
    distribution: { high: number; medium: number; low: number; archive: number };
  } {
    const memories = loadMemoryFiles(this.scores);
    const scores = memories.map((m) => scoreMemory(m).score);
    const total = scores.length;
    const avgScore = total > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / total) : 0;

    const distribution = { high: 0, medium: 0, low: 0, archive: 0 };
    for (const s of scores) {
      const level = scoreToLevel(s);
      if (level === "critical" || level === "high") distribution.high++;
      else if (level === "medium") distribution.medium++;
      else if (level === "low") distribution.low++;
      else distribution.archive++;
    }

    return { total, avgScore, distribution };
  }

  private getOrCreateRecord(memoryId: string): ScoreRecord {
    if (!this.scores.records[memoryId]) {
      this.scores.records[memoryId] = {
        memoryId,
        score: 50,
        level: "medium",
        lastAccessed: Date.now(),
        accessCount: 0,
        userFeedback: null,
        lastDecay: Date.now(),
      };
    }
    return this.scores.records[memoryId];
  }

  private runDailyDecay(): void {
    const now = Date.now();
    const lastRun = this.scores.lastDecayRun || 0;
    const daysSinceDecay = (now - lastRun) / MS_PER_DAY;

    if (daysSinceDecay < 1) return;

    const decayDays = Math.floor(daysSinceDecay);
    for (const [, rec] of Object.entries(this.scores.records)) {
      const daysSinceAccess = (now - rec.lastAccessed) / MS_PER_DAY;
      if (daysSinceAccess > 1) {
        const decay = Math.min(decayDays, Math.floor(daysSinceAccess)) * DECAY_PER_DAY;
        rec.score = Math.max(0, rec.score - decay);
        rec.level = scoreToLevel(rec.score);
      }
    }

    this.scores.lastDecayRun = now;
    this.persist();
  }

  private persist(): void {
    persistScores(this.scores);
  }
}
