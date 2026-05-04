/**
 * Local Agent X — Memory Importance Scoring
 *
 * Scores and ranks memories by importance using weighted factors:
 * recency, frequency, user feedback, content richness, emotional weight.
 * Manages archival of low-importance memories.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// ══════════════════════════════════════════════════════════
//  Types
// ══════════════════════════════════════════════════════════

export interface MemoryEntry {
  id: string;
  content: string;
  createdAt: number;
  lastAccessed?: number;
  accessCount?: number;
  userFeedback?: "positive" | "negative";
}

export interface ImportanceScore {
  score: number;
  factors: {
    recency: number;
    frequency: number;
    feedback: number;
    richness: number;
    emotional: number;
  };
  level: "critical" | "high" | "medium" | "low" | "archive";
}

export interface ArchiveResult {
  archived: string[];
  kept: string[];
  dryRun: boolean;
}

interface ScoreRecord {
  memoryId: string;
  score: number;
  level: string;
  lastAccessed: number;
  accessCount: number;
  userFeedback: "positive" | "negative" | null;
  lastDecay: number;
}

interface ScoresData {
  records: Record<string, ScoreRecord>;
  lastDecayRun: number;
}

// ══════════════════════════════════════════════════════════
//  Constants
// ══════════════════════════════════════════════════════════

const LAX_DIR = join(homedir(), ".lax");
const MEMORY_DIR = join(LAX_DIR, "memory");
const ARCHIVE_DIR = join(LAX_DIR, "memory-archive");
const SCORES_FILE = join(LAX_DIR, "memory-scores.json");

const PROTECTED_FILES = new Set([
  "IDENTITY.md",
  "HEART.md",
  "USER.md",
  "MIND.md",
]);

const WEIGHTS = {
  recency: 0.25,
  frequency: 0.30,
  feedback: 0.20,
  richness: 0.15,
  emotional: 0.10,
};

const RECENCY_HALF_LIFE_DAYS = 14;
const DEFAULT_ARCHIVE_THRESHOLD = 15;
const DECAY_PER_DAY = 1;
const MS_PER_DAY = 86400000;

const EMOTION_KEYWORDS = [
  "love", "hate", "angry", "happy", "sad", "excited", "afraid", "fear",
  "joy", "grief", "proud", "shame", "grateful", "anxious", "thrilled",
  "frustrated", "devastated", "ecstatic", "furious", "heartbroken",
  "passionate", "terrified", "disgusted", "amazed", "worried",
  "delighted", "miserable", "euphoric", "desperate", "hopeful",
  "important", "urgent", "critical", "emergency", "breakthrough",
];

// ══════════════════════════════════════════════════════════
//  Singleton
// ══════════════════════════════════════════════════════════

export class MemoryImportance {
  private static instance: MemoryImportance;
  private scores: ScoresData;

  private constructor() {
    this.ensureDirs();
    this.scores = this.loadScores();
    this.runDailyDecay();
  }

  static getInstance(): MemoryImportance {
    if (!MemoryImportance.instance) {
      MemoryImportance.instance = new MemoryImportance();
    }
    return MemoryImportance.instance;
  }

  // ── Scoring ──────────────────────────────────────────────

  scoreMemory(memory: {
    content: string;
    createdAt: number;
    lastAccessed?: number;
    accessCount?: number;
    userFeedback?: "positive" | "negative";
  }): ImportanceScore {
    const now = Date.now();

    // Recency: exponential decay with 14-day half-life
    const referenceTime = memory.lastAccessed || memory.createdAt;
    const daysSince = Math.max(0, (now - referenceTime) / MS_PER_DAY);
    const recency = Math.pow(0.5, daysSince / RECENCY_HALF_LIFE_DAYS) * 100;

    // Frequency: log(accessCount + 1), normalized 0-100
    const rawFreq = Math.log(Math.max(0, memory.accessCount || 0) + 1);
    const maxFreq = Math.log(101); // normalize against ~100 accesses
    const frequency = Math.min(100, (rawFreq / maxFreq) * 100);

    // User feedback: positive=100, negative=10, neutral=50
    let feedback = 50;
    if (memory.userFeedback === "positive") feedback = 100;
    else if (memory.userFeedback === "negative") feedback = 10;

    // Content richness: length + entity density
    const richness = this.calcRichness(memory.content);

    // Emotional weight
    const emotional = this.calcEmotional(memory.content);

    const score = Math.round(
      WEIGHTS.recency * recency +
      WEIGHTS.frequency * frequency +
      WEIGHTS.feedback * feedback +
      WEIGHTS.richness * richness +
      WEIGHTS.emotional * emotional
    );

    const clampedScore = Math.max(0, Math.min(100, score));

    return {
      score: clampedScore,
      factors: {
        recency: Math.round(recency * 10) / 10,
        frequency: Math.round(frequency * 10) / 10,
        feedback,
        richness: Math.round(richness * 10) / 10,
        emotional: Math.round(emotional * 10) / 10,
      },
      level: this.scoreToLevel(clampedScore),
    };
  }

  // ── Access & Feedback ────────────────────────────────────

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

  // ── Ranking ──────────────────────────────────────────────

  rankMemories(memories: MemoryEntry[]): MemoryEntry[] {
    const scored = memories.map((m) => ({
      memory: m,
      score: this.scoreMemory(m).score,
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.memory);
  }

  // ── Archival ─────────────────────────────────────────────

  getArchiveCandidates(threshold?: number): MemoryEntry[] {
    const cutoff = threshold ?? DEFAULT_ARCHIVE_THRESHOLD;
    const memories = this.loadMemoryFiles();
    return memories.filter((m) => {
      if (PROTECTED_FILES.has(basename(m.id))) return false;
      return this.scoreMemory(m).score < cutoff;
    });
  }

  autoArchive(dryRun?: boolean): ArchiveResult {
    const candidates = this.getArchiveCandidates();
    const archived: string[] = [];
    const kept: string[] = [];

    const allFiles = this.listMemoryFiles();
    for (const filename of allFiles) {
      if (PROTECTED_FILES.has(filename)) {
        kept.push(filename);
        continue;
      }

      const entry = this.fileToEntry(filename);
      if (!entry) {
        kept.push(filename);
        continue;
      }

      const result = this.scoreMemory(entry);
      if (result.score < DEFAULT_ARCHIVE_THRESHOLD) {
        if (!dryRun) {
          this.moveToArchive(filename);
        }
        archived.push(filename);
      } else {
        kept.push(filename);
      }
    }

    return { archived, kept, dryRun: !!dryRun };
  }

  // ── Stats ────────────────────────────────────────────────

  getImportanceStats(): {
    total: number;
    avgScore: number;
    distribution: { high: number; medium: number; low: number; archive: number };
  } {
    const memories = this.loadMemoryFiles();
    const scores = memories.map((m) => this.scoreMemory(m).score);
    const total = scores.length;
    const avgScore = total > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / total) : 0;

    const distribution = { high: 0, medium: 0, low: 0, archive: 0 };
    for (const s of scores) {
      const level = this.scoreToLevel(s);
      if (level === "critical" || level === "high") distribution.high++;
      else if (level === "medium") distribution.medium++;
      else if (level === "low") distribution.low++;
      else distribution.archive++;
    }

    return { total, avgScore, distribution };
  }

  // ══════════════════════════════════════════════════════════
  //  Internal helpers
  // ══════════════════════════════════════════════════════════

  private calcRichness(content: string): number {
    const length = content.length;
    // Length factor: 0-100 based on content length (cap at 5000 chars)
    const lengthScore = Math.min(100, (length / 5000) * 100);

    // Entity density: count @mentions, [[links]], markdown headers, URLs
    const entities =
      (content.match(/@\w+/g)?.length || 0) +
      (content.match(/\[\[.+?\]\]/g)?.length || 0) +
      (content.match(/^#{1,3}\s/gm)?.length || 0) +
      (content.match(/https?:\/\/\S+/g)?.length || 0);
    const entityScore = Math.min(100, entities * 10);

    return (lengthScore * 0.6 + entityScore * 0.4);
  }

  private calcEmotional(content: string): number {
    const lower = content.toLowerCase();
    let hits = 0;
    for (const kw of EMOTION_KEYWORDS) {
      if (lower.includes(kw)) hits++;
    }
    // Normalize: 0 hits = 20 (baseline), 5+ hits = 100
    return Math.min(100, 20 + hits * 16);
  }

  private scoreToLevel(score: number): "critical" | "high" | "medium" | "low" | "archive" {
    if (score >= 80) return "critical";
    if (score >= 60) return "high";
    if (score >= 35) return "medium";
    if (score >= 15) return "low";
    return "archive";
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
    for (const [id, rec] of Object.entries(this.scores.records)) {
      const daysSinceAccess = (now - rec.lastAccessed) / MS_PER_DAY;
      if (daysSinceAccess > 1) {
        const decay = Math.min(decayDays, Math.floor(daysSinceAccess)) * DECAY_PER_DAY;
        rec.score = Math.max(0, rec.score - decay);
        rec.level = this.scoreToLevel(rec.score);
      }
    }

    this.scores.lastDecayRun = now;
    this.persist();
  }

  private loadMemoryFiles(): MemoryEntry[] {
    const files = this.listMemoryFiles();
    const entries: MemoryEntry[] = [];
    for (const f of files) {
      const entry = this.fileToEntry(f);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  private listMemoryFiles(): string[] {
    if (!existsSync(MEMORY_DIR)) return [];
    try {
      return readdirSync(MEMORY_DIR).filter((f) => f.endsWith(".md"));
    } catch {
      return [];
    }
  }

  private fileToEntry(filename: string): MemoryEntry | null {
    const filePath = join(MEMORY_DIR, filename);
    try {
      const stat = statSync(filePath);
      const content = readFileSync(filePath, "utf-8");
      const rec = this.scores.records[filename];
      return {
        id: filename,
        content,
        createdAt: stat.birthtimeMs || stat.ctimeMs,
        lastAccessed: rec?.lastAccessed || stat.mtimeMs,
        accessCount: rec?.accessCount || 0,
        userFeedback: rec?.userFeedback || undefined,
      };
    } catch {
      return null;
    }
  }

  private moveToArchive(filename: string): void {
    const src = join(MEMORY_DIR, filename);
    const dst = join(ARCHIVE_DIR, filename);
    try {
      if (!existsSync(ARCHIVE_DIR)) {
        mkdirSync(ARCHIVE_DIR, { recursive: true });
      }
      renameSync(src, dst);
      delete this.scores.records[filename];
      this.persist();
    } catch {
      // silently skip if move fails
    }
  }

  // ── Persistence ──────────────────────────────────────────

  private loadScores(): ScoresData {
    try {
      if (existsSync(SCORES_FILE)) {
        const raw = readFileSync(SCORES_FILE, "utf-8");
        return JSON.parse(raw);
      }
    } catch {
      // corrupted file — start fresh
    }
    return { records: {}, lastDecayRun: Date.now() };
  }

  private persist(): void {
    try {
      const tmp = SCORES_FILE + ".tmp";
      writeFileSync(tmp, JSON.stringify(this.scores, null, 2), "utf-8");
      renameSync(tmp, SCORES_FILE);
    } catch {
      try { writeFileSync(SCORES_FILE, JSON.stringify(this.scores, null, 2), "utf-8"); } catch {}
    }
  }

  private ensureDirs(): void {
    for (const dir of [LAX_DIR, MEMORY_DIR, ARCHIVE_DIR]) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }
}

export default MemoryImportance.getInstance();
