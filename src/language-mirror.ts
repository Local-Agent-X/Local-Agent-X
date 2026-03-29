/**
 * Language Mirror — Gradually adopt the user's communication style.
 *
 * Tracks greeting patterns, emoji usage, slang, sentence length, formality,
 * and punctuation habits across many messages to build an evolving style
 * profile used for response adaptation.
 *
 * Persists to ~/.sax/language-style.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// ── Types ────────────────────────────────────────────────────

export interface StyleProfile {
  greetingStyle: "casual" | "formal" | "minimal";
  emojiUsage: "heavy" | "moderate" | "rare" | "never";
  avgSentenceLength: number;
  slangTerms: string[];
  punctuationStyle: "enthusiastic" | "normal" | "minimal";
  formality: number; // 0 = very casual, 1 = very formal
  signatureWords: string[];
  sampleSize: number;
}

interface StyleStore {
  greetings: Record<string, number>;
  emojiCount: number;
  messageCount: number;
  totalSentences: number;
  totalWords: number;
  wordFrequency: Record<string, number>;
  slangCounts: Record<string, number>;
  exclamationMessages: number;
  noPunctuationMessages: number;
  formalMarkers: number;
  casualMarkers: number;
}

// ── Constants ───────────────────────────────────────────────

const SAX_DIR = join(homedir(), ".sax");
const STORE_FILE = join(SAX_DIR, "language-style.json");

const CASUAL_GREETINGS = /^(yo|hey|sup|ayy|heyy|heya|yoo|waddup|what'?s? ?up)\b/i;
const FORMAL_GREETINGS = /^(hello|good morning|good afternoon|good evening|greetings|dear)\b/i;
const MINIMAL_GREETINGS = /^(hi|ok|k|sure)\b/i;

const EMOJI_RE = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}]/gu;

const KNOWN_SLANG = [
  "lol", "lmao", "ngl", "fr", "tbh", "imo", "smh", "bruh", "fam",
  "lowkey", "highkey", "goated", "bussin", "bet", "vibe", "vibes",
  "fire", "cap", "no cap", "deadass", "lit", "sus", "slay", "yeet",
  "dope", "sick", "hella", "gonna", "wanna", "gotta", "kinda", "sorta",
  "nah", "yeah", "yep", "nope", "aight", "ight", "prolly", "tho",
];

const FORMAL_MARKERS_RE = /\b(please|kindly|would you|could you|I would appreciate|thank you|regards|sincerely|furthermore|however|therefore|consequently)\b/gi;
const CASUAL_MARKERS_RE = /\b(gonna|wanna|gotta|kinda|sorta|cuz|coz|ya|u |ur |pls|thx|ty|np|lol|lmao|haha|omg|btw)\b/gi;

// Common English words to exclude from signature word detection
const COMMON_WORDS = new Set([
  "the", "be", "to", "of", "and", "a", "in", "that", "have", "i",
  "it", "for", "not", "on", "with", "he", "as", "you", "do", "at",
  "this", "but", "his", "by", "from", "they", "we", "her", "she",
  "or", "an", "will", "my", "one", "all", "would", "there", "their",
  "what", "so", "up", "out", "if", "about", "who", "get", "which",
  "go", "me", "when", "make", "can", "like", "time", "no", "just",
  "him", "know", "take", "people", "into", "year", "your", "good",
  "some", "could", "them", "see", "other", "than", "then", "now",
  "look", "only", "come", "its", "over", "think", "also", "back",
  "after", "use", "how", "our", "work", "first", "well", "way",
  "even", "new", "want", "because", "any", "these", "give", "day",
  "most", "us", "is", "are", "was", "were", "been", "has", "had",
  "did", "does", "am", "being", "here", "very", "much", "too",
  "don't", "didn't", "doesn't", "isn't", "aren't", "wasn't", "won't",
  "can't", "couldn't", "shouldn't", "wouldn't", "it's", "i'm",
  "let", "need", "should", "thing", "things", "really", "still",
]);

// ── Persistence ─────────────────────────────────────────────

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

function loadStore(): StyleStore {
  if (!existsSync(STORE_FILE)) return emptyStore();
  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...emptyStore(), ...parsed };
  } catch {
    return emptyStore();
  }
}

function emptyStore(): StyleStore {
  return {
    greetings: {},
    emojiCount: 0,
    messageCount: 0,
    totalSentences: 0,
    totalWords: 0,
    wordFrequency: {},
    slangCounts: {},
    exclamationMessages: 0,
    noPunctuationMessages: 0,
    formalMarkers: 0,
    casualMarkers: 0,
  };
}

function saveStore(store: StyleStore): void {
  ensureDir();
  atomicWrite(STORE_FILE, JSON.stringify(store, null, 2));
}

// ── LanguageMirror class ────────────────────────────────────

export class LanguageMirror {
  private static instance: LanguageMirror | null = null;
  private store: StyleStore;

  private constructor() {
    this.store = loadStore();
  }

  static getInstance(): LanguageMirror {
    if (!LanguageMirror.instance) LanguageMirror.instance = new LanguageMirror();
    return LanguageMirror.instance;
  }

  /** Analyze a user message and update style tracking. */
  recordUserStyle(message: string): void {
    if (!message || message.trim().length === 0) return;

    const trimmed = message.trim();
    this.store.messageCount++;

    // Greetings
    const firstLine = trimmed.split("\n")[0];
    if (CASUAL_GREETINGS.test(firstLine)) {
      const match = firstLine.match(CASUAL_GREETINGS)?.[1]?.toLowerCase() ?? "casual";
      this.store.greetings[match] = (this.store.greetings[match] ?? 0) + 1;
    } else if (FORMAL_GREETINGS.test(firstLine)) {
      const match = firstLine.match(FORMAL_GREETINGS)?.[1]?.toLowerCase() ?? "formal";
      this.store.greetings[match] = (this.store.greetings[match] ?? 0) + 1;
    } else if (MINIMAL_GREETINGS.test(firstLine)) {
      this.store.greetings["_minimal"] = (this.store.greetings["_minimal"] ?? 0) + 1;
    }

    // Emoji
    const emojis = trimmed.match(EMOJI_RE);
    if (emojis) this.store.emojiCount += emojis.length;

    // Sentence / word counts
    const sentences = trimmed.split(/[.!?]+/).filter(s => s.trim().length > 0);
    this.store.totalSentences += sentences.length;

    const words = trimmed.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    this.store.totalWords += words.length;

    // Word frequency (skip common words)
    for (const w of words) {
      const clean = w.replace(/[^a-z'-]/g, "");
      if (clean.length > 2 && !COMMON_WORDS.has(clean)) {
        this.store.wordFrequency[clean] = (this.store.wordFrequency[clean] ?? 0) + 1;
      }
    }

    // Slang
    for (const term of KNOWN_SLANG) {
      const re = new RegExp(`\\b${term}\\b`, "gi");
      const matches = trimmed.match(re);
      if (matches) {
        this.store.slangCounts[term] = (this.store.slangCounts[term] ?? 0) + matches.length;
      }
    }

    // Punctuation style
    if (/[!]{2,}/.test(trimmed) || (trimmed.match(/!/g)?.length ?? 0) >= 2) {
      this.store.exclamationMessages++;
    }
    if (!/[.!?]$/.test(trimmed)) {
      this.store.noPunctuationMessages++;
    }

    // Formality markers
    const formalHits = trimmed.match(FORMAL_MARKERS_RE);
    if (formalHits) this.store.formalMarkers += formalHits.length;
    const casualHits = trimmed.match(CASUAL_MARKERS_RE);
    if (casualHits) this.store.casualMarkers += casualHits.length;

    saveStore(this.store);
  }

  /** Get the current computed style profile. */
  getStyleProfile(): StyleProfile {
    const s = this.store;
    const count = Math.max(s.messageCount, 1);

    // Greeting style
    let greetingStyle: StyleProfile["greetingStyle"] = "minimal";
    const casualCount = Object.entries(s.greetings)
      .filter(([k]) => !k.startsWith("_") && CASUAL_GREETINGS.test(k))
      .reduce((sum, [, v]) => sum + v, 0);
    const formalCount = Object.entries(s.greetings)
      .filter(([k]) => FORMAL_GREETINGS.test(k))
      .reduce((sum, [, v]) => sum + v, 0);
    // also add explicit casual greeting words
    const totalCasualGreetings = casualCount + Object.entries(s.greetings)
      .filter(([k]) => ["yo", "hey", "sup", "ayy", "heyy", "heya", "yoo"].includes(k))
      .reduce((sum, [, v]) => sum + v, 0);

    if (totalCasualGreetings > formalCount && totalCasualGreetings > (s.greetings["_minimal"] ?? 0)) {
      greetingStyle = "casual";
    } else if (formalCount > totalCasualGreetings && formalCount > (s.greetings["_minimal"] ?? 0)) {
      greetingStyle = "formal";
    }

    // Emoji usage
    const emojiPerMsg = s.emojiCount / count;
    let emojiUsage: StyleProfile["emojiUsage"] = "never";
    if (emojiPerMsg >= 2) emojiUsage = "heavy";
    else if (emojiPerMsg >= 0.5) emojiUsage = "moderate";
    else if (emojiPerMsg > 0) emojiUsage = "rare";

    // Average sentence length
    const avgSentenceLength = s.totalSentences > 0
      ? Math.round(s.totalWords / s.totalSentences)
      : 0;

    // Slang terms (those used 3+ times)
    const slangTerms = Object.entries(s.slangCounts)
      .filter(([, c]) => c >= 3)
      .sort((a, b) => b[1] - a[1])
      .map(([term]) => term);

    // Punctuation style
    const exclamationRate = s.exclamationMessages / count;
    const noPuncRate = s.noPunctuationMessages / count;
    let punctuationStyle: StyleProfile["punctuationStyle"] = "normal";
    if (exclamationRate > 0.3) punctuationStyle = "enthusiastic";
    else if (noPuncRate > 0.6) punctuationStyle = "minimal";

    // Formality (0 = casual, 1 = formal)
    const totalMarkers = s.formalMarkers + s.casualMarkers;
    let formality = 0.5;
    if (totalMarkers > 0) {
      formality = Math.round((s.formalMarkers / totalMarkers) * 100) / 100;
    }

    // Signature words — unusually frequent
    const sortedWords = Object.entries(s.wordFrequency)
      .filter(([, c]) => c >= 5)
      .sort((a, b) => b[1] - a[1]);
    const signatureWords = sortedWords.slice(0, 10).map(([w]) => w);

    return {
      greetingStyle,
      emojiUsage,
      avgSentenceLength,
      slangTerms,
      punctuationStyle,
      formality,
      signatureWords,
      sampleSize: s.messageCount,
    };
  }

  /** Get an adapted greeting based on the user's style. */
  getAdaptedGreeting(): string {
    const profile = this.getStyleProfile();

    if (profile.sampleSize < 5) return "Hey there";

    // Pick from observed greetings with highest count
    const topGreeting = Object.entries(this.store.greetings)
      .filter(([k]) => k !== "_minimal")
      .sort((a, b) => b[1] - a[1])[0]?.[0];

    if (profile.greetingStyle === "casual") {
      if (topGreeting === "yo") return "Yo!";
      if (topGreeting === "sup") return "Sup";
      return "Hey";
    }
    if (profile.greetingStyle === "formal") return "Hello, Alex";
    return "Hey";
  }

  /** Whether to use emoji in responses based on observed style. */
  shouldUseEmoji(): boolean {
    const profile = this.getStyleProfile();
    return profile.emojiUsage === "heavy" || profile.emojiUsage === "moderate";
  }

  /** Only mirror slang the user has used 3+ times. */
  shouldUseSlang(term: string): boolean {
    return (this.store.slangCounts[term.toLowerCase()] ?? 0) >= 3;
  }

  /** Generate a style hint for injection into the system prompt. */
  getStyleHint(): string {
    const profile = this.getStyleProfile();
    if (profile.sampleSize < 10) return "";

    const parts: string[] = [];

    if (profile.formality < 0.3) parts.push("User communicates very casually");
    else if (profile.formality < 0.5) parts.push("User communicates casually with some slang");
    else if (profile.formality > 0.7) parts.push("User communicates formally");

    parts.push(`Match their energy`);

    if (profile.avgSentenceLength < 8) parts.push("Use short sentences");
    else if (profile.avgSentenceLength > 20) parts.push("Longer, detailed sentences are fine");

    if (profile.emojiUsage === "heavy") parts.push("Emoji OK");
    else if (profile.emojiUsage === "moderate") parts.push("Occasional emoji OK");
    else if (profile.emojiUsage === "never") parts.push("No emoji");

    if (profile.slangTerms.length > 0) {
      parts.push(`Familiar slang: ${profile.slangTerms.slice(0, 5).join(", ")}`);
    }

    if (profile.punctuationStyle === "enthusiastic") parts.push("Enthusiastic punctuation OK");
    else if (profile.punctuationStyle === "minimal") parts.push("Minimal punctuation preferred");

    return parts.join(". ") + ".";
  }

  /** Reload store from disk. */
  reload(): void {
    this.store = loadStore();
  }

  /** Reset singleton (testing). */
  static reset(): void {
    LanguageMirror.instance = null;
  }
}
