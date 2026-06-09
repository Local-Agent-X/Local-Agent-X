/**
 * Emotional Memory — tracks user emotional states across conversations
 * to enable empathetic, adaptive responses.
 *
 * Persists to ~/.lax/emotional-history.json (max 1000 entries, FIFO).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { getLaxDir } from "./lax-data-dir.js";
import type { ModuleSignal } from "./orchestrator/types.js";
import {
  EMOTION_KEYWORDS,
  EMOJI_EMOTION,
  ADAPTATION_HINTS,
} from "./emotional-lexicon.js";
import type {
  Emotion,
  EmotionState,
  EmotionRecord,
  EmotionalProfile,
} from "./emotional-lexicon.js";

export type { Emotion, EmotionState, EmotionRecord, EmotionalProfile };

// ── Persistence ─────────────────────────────────────────────

const LAX_DIR = getLaxDir();
const HISTORY_FILE = join(LAX_DIR, "emotional-history.json");
const MAX_ENTRIES = 1000;

function ensureDir(): void {
  if (!existsSync(LAX_DIR)) mkdirSync(LAX_DIR, { recursive: true });
}

function atomicWrite(path: string, data: string): void {
  const tmp = path + ".tmp." + randomBytes(4).toString("hex");
  try {
    writeFileSync(tmp, data, "utf-8");
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

function loadHistory(): EmotionRecord[] {
  try {
    if (existsSync(HISTORY_FILE)) {
      const raw = readFileSync(HISTORY_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.records)) return parsed.records;
    }
  } catch {}
  return [];
}

function saveHistory(records: EmotionRecord[]): void {
  ensureDir();
  // FIFO: keep only the most recent MAX_ENTRIES
  const trimmed = records.length > MAX_ENTRIES
    ? records.slice(records.length - MAX_ENTRIES)
    : records;
  atomicWrite(HISTORY_FILE, JSON.stringify({ records: trimmed }, null, 2));
}

// ── EmotionalMemory class ───────────────────────────────────

class EmotionalMemoryImpl {
  private records: EmotionRecord[];

  constructor() {
    this.records = loadHistory();
  }

  /**
   * Analyze text for emotional signals using keyword/pattern matching.
   */
  detectEmotion(text: string): EmotionState {
    const lower = text.toLowerCase();
    const scores: Record<Emotion, { score: number; signals: string[] }> = {} as any;

    for (const em of Object.keys(EMOTION_KEYWORDS) as Emotion[]) {
      scores[em] = { score: 0, signals: [] };
    }

    // 1) Keyword matching
    for (const [emotion, keywords] of Object.entries(EMOTION_KEYWORDS) as [Emotion, string[]][]) {
      for (const kw of keywords) {
        if (lower.includes(kw)) {
          scores[emotion].score += 2;
          scores[emotion].signals.push(`keyword:"${kw}"`);
        }
      }
    }

    // 2) Punctuation patterns
    if (/!{2,}/.test(text)) {
      // Multiple exclamation marks suggest excitement or frustration
      scores.excited.score += 1;
      scores.excited.signals.push("punctuation:!!!");
      scores.frustrated.score += 0.5;
      scores.frustrated.signals.push("punctuation:!!!");
    }
    if (/\?{2,}/.test(text)) {
      scores.confused.score += 1.5;
      scores.confused.signals.push("punctuation:???");
    }
    if (/\.{3,}/.test(text)) {
      scores.bored.score += 0.5;
      scores.bored.signals.push("punctuation:...");
      scores.stressed.score += 0.5;
      scores.stressed.signals.push("punctuation:...");
    }

    // 3) CAPS usage (more than 40% uppercase in a message > 10 chars)
    if (text.length > 10) {
      const alphaChars = text.replace(/[^a-zA-Z]/g, "");
      if (alphaChars.length > 5) {
        const upperRatio = alphaChars.replace(/[^A-Z]/g, "").length / alphaChars.length;
        if (upperRatio > 0.4) {
          scores.angry.score += 1.5;
          scores.angry.signals.push("caps-usage");
          scores.excited.score += 1;
          scores.excited.signals.push("caps-usage");
        }
      }
    }

    // 4) Emoji detection
    for (const { pattern, emotion } of EMOJI_EMOTION) {
      if (pattern.test(text)) {
        scores[emotion].score += 1.5;
        scores[emotion].signals.push("emoji");
      }
    }

    // Find the highest-scoring emotion
    let best: Emotion = "calm";
    let bestScore = 0;
    for (const [emotion, data] of Object.entries(scores) as [Emotion, { score: number; signals: string[] }][]) {
      if (data.score > bestScore) {
        bestScore = data.score;
        best = emotion;
      }
    }

    // Compute confidence: normalize score into 0–1 range
    // A score of 6+ is very high confidence
    const confidence = bestScore === 0 ? 0.1 : Math.min(1, bestScore / 6);

    return {
      primary: best,
      confidence: Math.round(confidence * 100) / 100,
      signals: scores[best].signals,
    };
  }

  /**
   * Store an emotion record with timestamp.
   */
  recordEmotion(sessionId: string, emotion: EmotionState, context: string): void {
    const record: EmotionRecord = {
      sessionId,
      emotion,
      context: context.slice(0, 200), // truncate context to save space
      timestamp: Date.now(),
    };
    this.records.push(record);
    saveHistory(this.records);
  }

  /**
   * Get recent emotional history, optionally filtered by session.
   */
  getEmotionalHistory(sessionId?: string, limit = 50): EmotionRecord[] {
    let filtered = this.records;
    if (sessionId) {
      filtered = filtered.filter((r) => r.sessionId === sessionId);
    }
    return filtered.slice(-limit);
  }

  /**
   * Build an aggregate emotional profile across all stored history.
   */
  getEmotionalProfile(): EmotionalProfile {
    const total = this.records.length;
    if (total === 0) {
      return {
        totalRecords: 0,
        topEmotions: [],
        triggers: [],
        timeOfDayPatterns: [],
        summary: "No emotional data recorded yet.",
      };
    }

    // Count emotions
    const counts: Record<string, number> = {};
    for (const r of this.records) {
      const em = r.emotion.primary;
      counts[em] = (counts[em] || 0) + 1;
    }
    const topEmotions = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([emotion, count]) => ({
        emotion: emotion as Emotion,
        count,
        pct: Math.round((count / total) * 100),
      }));

    // Triggers: extract common context keywords per emotion
    const triggerMap: Record<string, Map<string, number>> = {};
    for (const r of this.records) {
      const em = r.emotion.primary;
      if (!triggerMap[em]) triggerMap[em] = new Map();
      // Extract meaningful words from context
      const words = r.context.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
      for (const w of words) {
        triggerMap[em]!.set(w, (triggerMap[em]!.get(w) || 0) + 1);
      }
    }
    const triggers: EmotionalProfile["triggers"] = [];
    for (const [emotion, wordMap] of Object.entries(triggerMap)) {
      const sorted = [...wordMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      for (const [context, occurrences] of sorted) {
        if (occurrences >= 2) {
          triggers.push({ context, emotion: emotion as Emotion, occurrences });
        }
      }
    }

    // Time-of-day patterns: bucket by hour
    const hourBuckets: Record<number, Record<string, number>> = {};
    for (const r of this.records) {
      const hour = new Date(r.timestamp).getHours();
      if (!hourBuckets[hour]) hourBuckets[hour] = {};
      const em = r.emotion.primary;
      hourBuckets[hour][em] = (hourBuckets[hour][em] || 0) + 1;
    }
    const timeOfDayPatterns: EmotionalProfile["timeOfDayPatterns"] = [];
    for (const [hourStr, emotionCounts] of Object.entries(hourBuckets)) {
      const dominant = Object.entries(emotionCounts).sort((a, b) => b[1] - a[1])[0];
      if (dominant) {
        timeOfDayPatterns.push({
          hour: Number(hourStr),
          dominantEmotion: dominant[0] as Emotion,
        });
      }
    }
    timeOfDayPatterns.sort((a, b) => a.hour - b.hour);

    // Build summary
    const top3 = topEmotions.slice(0, 3).map((e) => `${e.emotion} (${e.pct}%)`).join(", ");
    const triggerSummary = triggers.slice(0, 5)
      .map((t) => `${t.emotion} when discussing "${t.context}"`)
      .join("; ");
    const summary = `Most common emotions: ${top3}.${triggerSummary ? ` Patterns: ${triggerSummary}.` : ""}`;

    return { totalRecords: total, topEmotions, triggers, timeOfDayPatterns, summary };
  }

  /**
   * Get a suggestion for how the agent should adapt to the current emotion.
   */
  getAdaptationHint(currentEmotion: EmotionState): string {
    return ADAPTATION_HINTS[currentEmotion.primary] || ADAPTATION_HINTS.calm;
  }

  /** Orchestrator signals for the current message: adaptation hint plus a shift cue. */
  signalsFor(message: string, sessionId: string): ModuleSignal[] {
    const out: ModuleSignal[] = [];
    const emotion = this.detectEmotion(message);
    if (emotion.confidence > 0.3) {
      out.push({
        source: "emotional-memory",
        signal: this.getAdaptationHint(emotion),
        priority: 5 + Math.round(emotion.confidence * 3),
        category: "emotion",
        confidence: 1.0,
      });
    }
    const history = this.getEmotionalHistory(sessionId, 5);
    if (history.length >= 2) {
      const prev = history[history.length - 1].emotion.primary;
      const curr = emotion.primary;
      if (prev !== curr && emotion.confidence > 0.5) {
        out.push({
          source: "emotional-memory",
          signal: `Emotional shift detected: moved from ${prev} to ${curr}`,
          priority: 7,
          category: "emotion-shift",
          confidence: 1.0,
        });
      }
    }
    return out;
  }

  /** Passively record the message's emotion when confident enough to be worth keeping. */
  recordFrom(message: string, sessionId: string): void {
    const emotion = this.detectEmotion(message);
    if (emotion.confidence > 0.2) {
      this.recordEmotion(sessionId, emotion, message.slice(0, 100));
    }
  }
}

export const EmotionalMemory = new EmotionalMemoryImpl();
