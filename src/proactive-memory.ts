/**
 * Proactive Memory — surfaces relevant memories and patterns before
 * the user asks. Learns interaction habits, topic associations, and
 * time-based routines to offer timely, natural suggestions.
 *
 * Persists patterns to ~/.sax/proactive-patterns.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// ── Types ────────────────────────────────────────────────────

export interface ProactiveSuggestion {
  type: "time" | "topic" | "behavioral" | "emotional" | "task";
  message: string;
  confidence: number; // 0–1
  source: string;
}

export interface InteractionPattern {
  type: "time" | "topic" | "behavioral" | "emotional" | "task";
  trigger: string;
  response: string;
  frequency: number;
  lastSeen: number;
  confidence: number;
}

interface InteractionRecord {
  sessionId: string;
  message: string;
  timestamp: number;
  topics: string[];
}

interface PatternsFile {
  patterns: InteractionPattern[];
  interactions: InteractionRecord[];
  topicIndex: Record<string, string[]>; // topic -> related topics seen together
}

// ── Persistence ─────────────────────────────────────────────

const SAX_DIR = join(homedir(), ".sax");
const PATTERNS_FILE = join(SAX_DIR, "proactive-patterns.json");
const MAX_INTERACTIONS = 2000;
const MAX_PATTERNS = 500;

function ensureDir(): void {
  if (!existsSync(SAX_DIR)) mkdirSync(SAX_DIR, { recursive: true });
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

function loadPatterns(): PatternsFile {
  try {
    if (existsSync(PATTERNS_FILE)) {
      const raw = readFileSync(PATTERNS_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.patterns)) return parsed as PatternsFile;
    }
  } catch {}
  return { patterns: [], interactions: [], topicIndex: {} };
}

function savePatterns(data: PatternsFile): void {
  ensureDir();
  // Trim to size limits
  if (data.interactions.length > MAX_INTERACTIONS) {
    data.interactions = data.interactions.slice(-MAX_INTERACTIONS);
  }
  if (data.patterns.length > MAX_PATTERNS) {
    // Keep patterns with highest confidence
    data.patterns.sort((a, b) => b.confidence - a.confidence);
    data.patterns = data.patterns.slice(0, MAX_PATTERNS);
  }
  atomicWrite(PATTERNS_FILE, JSON.stringify(data, null, 2));
}

// ── Topic extraction ────────────────────────────────────────

/** Simple topic extraction from a message based on word frequency and n-grams. */
function extractTopics(text: string): string[] {
  const lower = text.toLowerCase();
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "dare", "ought",
    "i", "you", "he", "she", "it", "we", "they", "me", "him", "her",
    "us", "them", "my", "your", "his", "its", "our", "their", "this",
    "that", "these", "those", "what", "which", "who", "whom", "whose",
    "and", "but", "or", "nor", "not", "so", "yet", "for", "to", "of",
    "in", "on", "at", "by", "with", "from", "up", "about", "into",
    "through", "during", "before", "after", "above", "below", "between",
    "just", "also", "very", "too", "quite", "really", "then", "than",
    "when", "where", "how", "all", "each", "every", "both", "few",
    "more", "most", "other", "some", "such", "no", "any", "many",
    "much", "own", "same", "here", "there", "now", "only", "even",
    "still", "already", "don't", "doesn't", "didn't", "won't",
    "can't", "couldn't", "shouldn't", "wouldn't", "let", "get",
    "got", "going", "want", "like", "know", "think", "make",
    "sure", "yeah", "yes", "okay", "ok", "hey", "hi", "hello",
    "please", "thanks", "thank", "well", "right",
  ]);

  const words = lower
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  // Deduplicate but preserve order
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const w of words) {
    if (!seen.has(w)) {
      seen.add(w);
      topics.push(w);
    }
  }

  // Also detect bigrams for compound topics
  for (let i = 0; i < words.length - 1; i++) {
    const bigram = words[i] + " " + words[i + 1];
    if (!seen.has(bigram)) {
      seen.add(bigram);
      topics.push(bigram);
    }
  }

  return topics.slice(0, 10); // cap at 10 topics per message
}

// ── Time helpers ────────────────────────────────────────────

function getTimeGreeting(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  if (hour >= 17 && hour < 21) return "Good evening";
  return "Working late";
}

function isLateNight(hour: number): boolean {
  return hour >= 23 || hour < 5;
}

function isWeekend(): boolean {
  const day = new Date().getDay();
  return day === 0 || day === 6;
}

// ── ProactiveMemory class ───────────────────────────────────

class ProactiveMemoryImpl {
  private data: PatternsFile;

  constructor() {
    this.data = loadPatterns();
  }

  /**
   * Analyze the current context and return proactive suggestions.
   */
  analyzeContext(
    currentMessage: string,
    recentMessages: Array<{ role: string; content: string }>,
    timeOfDay: number,
  ): ProactiveSuggestion[] {
    const suggestions: ProactiveSuggestion[] = [];
    const currentTopics = extractTopics(currentMessage);
    const hour = timeOfDay;

    // 1) Time-based patterns
    for (const hint of this.getTimeSuggestions(hour)) {
      suggestions.push({
        type: "time",
        message: hint,
        confidence: 0.6,
        source: "time-pattern",
      });
    }

    // 2) Topic-based: "last time you mentioned this, you also needed Y"
    for (const topic of currentTopics) {
      for (const hint of this.getTopicSuggestions(topic)) {
        suggestions.push({
          type: "topic",
          message: hint,
          confidence: 0.5,
          source: `topic:${topic}`,
        });
      }
    }

    // 3) Behavioral patterns: repeated questions
    const recentTexts = recentMessages.map((m) => m.content.toLowerCase());
    const currentLower = currentMessage.toLowerCase();
    const thisWeek = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentInteractions = this.data.interactions.filter((i) => i.timestamp > thisWeek);

    for (const topic of currentTopics) {
      const freq = recentInteractions.filter((i) =>
        i.topics.includes(topic),
      ).length;
      if (freq >= 3) {
        suggestions.push({
          type: "behavioral",
          message: `You've asked about "${topic}" ${freq} times this week. Want me to compile a reference or set up a shortcut?`,
          confidence: Math.min(0.9, 0.5 + freq * 0.1),
          source: `frequency:${topic}`,
        });
      }
    }

    // 4) Emotional patterns from stored patterns
    for (const pattern of this.data.patterns) {
      if (pattern.type === "emotional") {
        // Check if current topics overlap with the emotional trigger
        if (currentTopics.some((t) => pattern.trigger.includes(t))) {
          suggestions.push({
            type: "emotional",
            message: pattern.response,
            confidence: pattern.confidence,
            source: `emotional-pattern:${pattern.trigger}`,
          });
        }
      }
    }

    // 5) Incomplete tasks: look for "todo", "need to", "should" in past interactions
    // that haven't been followed up on
    const taskKeywords = ["need to", "should", "todo", "want to", "plan to", "going to"];
    for (const interaction of recentInteractions) {
      const msgLower = interaction.message.toLowerCase();
      for (const kw of taskKeywords) {
        if (msgLower.includes(kw)) {
          // Extract the task portion (rough heuristic: text after the keyword)
          const idx = msgLower.indexOf(kw);
          const taskFragment = interaction.message.slice(idx, idx + 80).trim();
          // Check if any recent message references this task (suggesting completion)
          const referenced = recentTexts.some((rt) =>
            interaction.topics.some((t) => rt.includes(t)),
          );
          if (!referenced && currentTopics.some((t) => interaction.topics.includes(t))) {
            suggestions.push({
              type: "task",
              message: `You previously mentioned: "${taskFragment}" — still on your list?`,
              confidence: 0.4,
              source: `incomplete-task:${interaction.timestamp}`,
            });
            break; // One task suggestion per interaction
          }
        }
      }
    }

    // Deduplicate by message and sort by confidence
    const seen = new Set<string>();
    const unique = suggestions.filter((s) => {
      if (seen.has(s.message)) return false;
      seen.add(s.message);
      return true;
    });

    return unique.sort((a, b) => b.confidence - a.confidence).slice(0, 5);
  }

  /**
   * Get time-of-day suggestions based on the hour and historical patterns.
   */
  getTimeSuggestions(hour: number): string[] {
    const hints: string[] = [];

    if (isLateNight(hour)) {
      // Check if user frequently works late
      const lateInteractions = this.data.interactions.filter((i) => {
        const h = new Date(i.timestamp).getHours();
        return h >= 23 || h < 5;
      });
      if (lateInteractions.length > 5) {
        hints.push("You seem to work late fairly often. Remember to take breaks when you need them.");
      } else {
        hints.push("It's getting late. Let me know if you want to wrap up and pick this up tomorrow.");
      }
    }

    // Check for patterns at this specific hour
    const hourInteractions = this.data.interactions.filter((i) => {
      const h = new Date(i.timestamp).getHours();
      return h === hour;
    });
    if (hourInteractions.length >= 5) {
      // Find common topics at this hour
      const topicFreq: Record<string, number> = {};
      for (const interaction of hourInteractions) {
        for (const t of interaction.topics) {
          topicFreq[t] = (topicFreq[t] || 0) + 1;
        }
      }
      const sorted = Object.entries(topicFreq).sort((a, b) => b[1] - a[1]);
      if (sorted.length > 0 && sorted[0][1] >= 3) {
        hints.push(`Around this time you often work on "${sorted[0][0]}".`);
      }
    }

    if (isWeekend()) {
      const weekendCount = this.data.interactions.filter((i) => {
        const d = new Date(i.timestamp).getDay();
        return d === 0 || d === 6;
      }).length;
      if (weekendCount > 10) {
        // User works weekends regularly, no need to comment
      } else if (weekendCount > 0) {
        hints.push("Weekend session — let me know if you want to keep things light.");
      }
    }

    return hints;
  }

  /**
   * Get suggestions based on topic associations from past interactions.
   */
  getTopicSuggestions(topic: string): string[] {
    const hints: string[] = [];
    const related = this.data.topicIndex[topic];

    if (related && related.length > 0) {
      // Find the most frequent co-occurring topics
      const freq: Record<string, number> = {};
      for (const t of related) {
        freq[t] = (freq[t] || 0) + 1;
      }
      const sorted = Object.entries(freq)
        .filter(([t]) => t !== topic)
        .sort((a, b) => b[1] - a[1]);

      if (sorted.length > 0 && sorted[0][1] >= 2) {
        hints.push(
          `When you've worked on "${topic}" before, you also tended to look at "${sorted[0][0]}".`,
        );
      }
    }

    return hints;
  }

  /**
   * Get alerts about recurring patterns worth surfacing.
   */
  getPatternAlerts(): string[] {
    const alerts: string[] = [];

    for (const pattern of this.data.patterns) {
      if (pattern.confidence >= 0.7 && pattern.frequency >= 3) {
        alerts.push(pattern.response);
      }
    }

    return alerts.slice(0, 5);
  }

  /**
   * Record a user interaction for pattern learning.
   */
  recordInteraction(sessionId: string, message: string, timestamp: number): void {
    const topics = extractTopics(message);

    this.data.interactions.push({ sessionId, message: message.slice(0, 300), timestamp, topics });

    // Update topic co-occurrence index
    for (let i = 0; i < topics.length; i++) {
      if (!this.data.topicIndex[topics[i]]) {
        this.data.topicIndex[topics[i]] = [];
      }
      for (let j = 0; j < topics.length; j++) {
        if (i !== j) {
          this.data.topicIndex[topics[i]].push(topics[j]);
        }
      }
      // Keep the index from growing unbounded: keep only last 50 associations per topic
      if (this.data.topicIndex[topics[i]].length > 50) {
        this.data.topicIndex[topics[i]] = this.data.topicIndex[topics[i]].slice(-50);
      }
    }

    // Auto-detect behavioral patterns
    this.detectBehavioralPatterns(topics, timestamp);

    savePatterns(this.data);
  }

  /**
   * Manually register a learned pattern.
   */
  learnPattern(pattern: InteractionPattern): void {
    // Check if pattern already exists (same type + trigger)
    const existing = this.data.patterns.find(
      (p) => p.type === pattern.type && p.trigger === pattern.trigger,
    );
    if (existing) {
      existing.frequency += 1;
      existing.lastSeen = Date.now();
      existing.confidence = Math.min(1, existing.confidence + 0.05);
      existing.response = pattern.response;
    } else {
      this.data.patterns.push({ ...pattern, lastSeen: Date.now() });
    }
    savePatterns(this.data);
  }

  /**
   * Auto-detect behavioral patterns from interaction history.
   */
  private detectBehavioralPatterns(currentTopics: string[], timestamp: number): void {
    const hour = new Date(timestamp).getHours();
    const oneWeek = 7 * 24 * 60 * 60 * 1000;
    const recent = this.data.interactions.filter((i) => timestamp - i.timestamp < oneWeek);

    // Detect time-topic correlations
    for (const topic of currentTopics) {
      const atSameHour = recent.filter((i) => {
        const h = new Date(i.timestamp).getHours();
        return Math.abs(h - hour) <= 1 && i.topics.includes(topic);
      });
      if (atSameHour.length >= 3) {
        const timeLabel = hour < 12 ? "mornings" : hour < 17 ? "afternoons" : "evenings";
        this.learnPattern({
          type: "time",
          trigger: `${topic}@${hour}`,
          response: `You tend to work on "${topic}" in the ${timeLabel}.`,
          frequency: atSameHour.length,
          lastSeen: timestamp,
          confidence: Math.min(0.9, 0.4 + atSameHour.length * 0.1),
        });
      }
    }
  }
}

export const ProactiveMemory = new ProactiveMemoryImpl();
