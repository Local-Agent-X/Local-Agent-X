/**
 * Emotional Memory — tracks user emotional states across conversations
 * to enable empathetic, adaptive responses.
 *
 * Persists to ~/.sax/emotional-history.json (max 1000 entries, FIFO).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// ── Types ────────────────────────────────────────────────────

export interface EmotionState {
  primary: Emotion;
  confidence: number; // 0–1
  signals: string[];
}

export type Emotion =
  | "happy"
  | "frustrated"
  | "excited"
  | "grateful"
  | "confused"
  | "stressed"
  | "calm"
  | "curious"
  | "bored"
  | "angry";

export interface EmotionRecord {
  sessionId: string;
  emotion: EmotionState;
  context: string;
  timestamp: number;
}

export interface EmotionalProfile {
  totalRecords: number;
  topEmotions: Array<{ emotion: Emotion; count: number; pct: number }>;
  triggers: Array<{ context: string; emotion: Emotion; occurrences: number }>;
  timeOfDayPatterns: Array<{ hour: number; dominantEmotion: Emotion }>;
  summary: string;
}

// ── Keyword / pattern tables ────────────────────────────────

const EMOTION_KEYWORDS: Record<Emotion, string[]> = {
  happy: [
    "love it", "awesome", "great", "wonderful", "fantastic", "nice",
    "perfect", "yay", "sweet", "amazing", "brilliant", "excellent",
    "happy", "glad", "thrilled", "delighted",
  ],
  frustrated: [
    "annoying", "frustrating", "broken", "doesn't work", "not working",
    "ugh", "again", "still broken", "why won't", "can't believe",
    "ridiculous", "terrible", "hate this", "so annoyed", "fed up",
  ],
  excited: [
    "can't wait", "excited", "let's go", "pumped", "stoked",
    "this is going to be", "just shipped", "finally", "woohoo",
    "let's do this", "so cool", "mind blown",
  ],
  grateful: [
    "thank you", "thanks", "appreciate", "grateful", "you're the best",
    "lifesaver", "helped a lot", "saved me", "couldn't have done",
    "so helpful", "much appreciated",
  ],
  confused: [
    "confused", "don't understand", "what do you mean", "huh",
    "makes no sense", "lost", "unclear", "not sure what",
    "how does", "wait what", "i'm lost", "explain",
  ],
  stressed: [
    "deadline", "running out of time", "too much", "overwhelmed",
    "stressed", "pressure", "urgent", "asap", "behind schedule",
    "crunch", "overloaded", "drowning",
  ],
  calm: [
    "no rush", "take your time", "whenever", "all good", "no worries",
    "relaxed", "chill", "easy", "peaceful", "steady",
  ],
  curious: [
    "wondering", "curious", "what if", "how would", "interesting",
    "tell me more", "explore", "dig into", "what about", "could we",
  ],
  bored: [
    "boring", "bored", "meh", "whatever", "don't care",
    "same old", "nothing new", "tedious", "monotonous",
  ],
  angry: [
    "angry", "furious", "pissed", "rage", "unacceptable",
    "livid", "outrageous", "infuriating", "wtf", "screw this",
    "this is garbage", "waste of time",
  ],
};

const EMOJI_EMOTION: Array<{ pattern: RegExp; emotion: Emotion }> = [
  { pattern: /[😀😁😂🤣😃😄😆😊🥳🎉🎊]/u, emotion: "happy" },
  { pattern: /[😤😠😡🤬💢]/u, emotion: "angry" },
  { pattern: /[😕😟🤔❓]/u, emotion: "confused" },
  { pattern: /[😩😫😰😥😓]/u, emotion: "stressed" },
  { pattern: /[🤩🚀✨💥🔥⚡]/u, emotion: "excited" },
  { pattern: /[🙏❤️💖💙👏]/u, emotion: "grateful" },
  { pattern: /[😐😑😶🥱💤]/u, emotion: "bored" },
  { pattern: /[😖😣😞😔]/u, emotion: "frustrated" },
  { pattern: /[🧐🔍💡]/u, emotion: "curious" },
  { pattern: /[😌☺️🧘🌿]/u, emotion: "calm" },
];

// ── Adaptation hints ────────────────────────────────────────

const ADAPTATION_HINTS: Record<Emotion, string> = {
  frustrated:
    "User seems frustrated. Be concise, avoid lengthy explanations, offer to take over the tedious parts.",
  angry:
    "User is upset. Acknowledge the frustration directly, stay solution-focused, avoid defensiveness.",
  confused:
    "User appears confused. Slow down, break things into smaller steps, use concrete examples.",
  stressed:
    "User is under pressure. Prioritize quick wins, offer to handle low-priority tasks, suggest breaks if appropriate.",
  excited:
    "User is excited! Match their energy, be enthusiastic, help them channel momentum productively.",
  happy:
    "User is in a good mood. Keep the positive tone, this is a great time for creative exploration.",
  grateful:
    "User expressed gratitude. Acknowledge warmly but briefly, keep the momentum going.",
  curious:
    "User is in exploration mode. Offer deeper dives, related topics, and alternative approaches.",
  bored:
    "User seems disengaged. Try introducing something novel, suggest a different approach, or ask what they'd prefer to work on.",
  calm:
    "User is relaxed and steady. Maintain a clear, measured pace. Good time for planning or review.",
};

// ── Persistence ─────────────────────────────────────────────

const LAX_DIR = join(homedir(), ".lax");
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
}

export const EmotionalMemory = new EmotionalMemoryImpl();
