/**
 * Narrative Memory — store memories as stories, not flat facts.
 *
 * Every significant event becomes a narrative with characters, emotions,
 * timeline context, and ongoing chapters. Stories grow over time as new
 * details emerge, creating a rich tapestry of shared history.
 *
 * Persists to ~/.lax/narratives.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { getLaxDir } from "./lax-data-dir.js";
import type { ModuleSignal } from "./orchestrator/types.js";

// ── Types ────────────────────────────────────────────────────

export interface NarrativeChapter {
  text: string;
  timestamp: number;
  emotions: string[];
}

export interface Narrative {
  id: string;
  title: string;
  summary: string;
  chapters: NarrativeChapter[];
  characters: string[];
  emotions: string[];
  tags: string[];
  startDate: string;
  endDate?: string;
  ongoing: boolean;
}

export interface NarrativeContext {
  emotions?: string[];
  characters?: string[];
  tags?: string[];
  relatedTo?: string;
}

interface NarrativeStore {
  narratives: Narrative[];
}

// ── Persistence ─────────────────────────────────────────────

const LAX_DIR = getLaxDir();
const STORE_FILE = join(LAX_DIR, "narratives.json");
const MAX_NARRATIVES = 2000;

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

function loadStore(): NarrativeStore {
  if (!existsSync(STORE_FILE)) return { narratives: [] };
  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return { narratives: Array.isArray(parsed.narratives) ? parsed.narratives : [] };
  } catch {
    return { narratives: [] };
  }
}

function saveStore(store: NarrativeStore): void {
  ensureDir();
  if (store.narratives.length > MAX_NARRATIVES) {
    store.narratives = store.narratives.slice(-MAX_NARRATIVES);
  }
  atomicWrite(STORE_FILE, JSON.stringify(store, null, 2));
}

function generateId(): string {
  return randomBytes(8).toString("hex");
}

function now(): number {
  return Date.now();
}

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Keyword helpers ─────────────────────────────────────────

const LIFE_EVENT_KEYWORDS = [
  "moved", "moving", "new job", "quit", "fired", "hired", "promoted",
  "married", "engaged", "broke up", "divorced", "pregnant", "baby",
  "graduated", "started school", "retired", "lost", "died", "passed away",
  "bought a house", "sold", "launched", "shipped", "released",
  "trip", "vacation", "traveling", "flew to", "driving to",
];

const PROJECT_KEYWORDS = [
  "building", "working on", "developing", "creating", "launching",
  "deployed", "shipped", "released", "finished", "completed", "started",
];

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
}

function textContains(text: string, phrase: string): boolean {
  return text.toLowerCase().includes(phrase.toLowerCase());
}

function scoreMatch(text: string, query: string): number {
  const tokens = tokenize(query);
  if (tokens.length === 0) return 0;
  const lowerText = text.toLowerCase();
  let hits = 0;
  for (const tok of tokens) {
    if (lowerText.includes(tok)) hits++;
  }
  return hits / tokens.length;
}

// ── NarrativeMemory ─────────────────────────────────────────

export class NarrativeMemory {
  private static instance: NarrativeMemory | null = null;

  private constructor() {}

  static getInstance(): NarrativeMemory {
    if (!NarrativeMemory.instance) {
      NarrativeMemory.instance = new NarrativeMemory();
    }
    return NarrativeMemory.instance;
  }

  /**
   * Create a new narrative from an event.
   * Builds a story entry: who, what, when, why, emotional tone, what led to it.
   */
  createNarrative(event: string, context: NarrativeContext): Narrative {
    const store = loadStore();

    const narrative: Narrative = {
      id: generateId(),
      title: this.generateTitle(event),
      summary: event,
      chapters: [
        {
          text: event,
          timestamp: now(),
          emotions: context.emotions || [],
        },
      ],
      characters: context.characters || [],
      emotions: context.emotions || [],
      tags: context.tags || [],
      startDate: dateStamp(),
      ongoing: true,
    };

    // Link to related narrative if specified
    if (context.relatedTo) {
      const related = store.narratives.find((n) => n.id === context.relatedTo);
      if (related) {
        narrative.tags.push(`related:${related.id}`);
      }
    }

    store.narratives.push(narrative);
    saveStore(store);
    return narrative;
  }

  /**
   * Add a chapter to an ongoing narrative.
   * Ongoing stories keep growing with new developments.
   */
  addChapter(narrativeId: string, chapter: string, context?: NarrativeContext): void {
    const store = loadStore();
    const narrative = store.narratives.find((n) => n.id === narrativeId);
    if (!narrative) return;

    const chapterEmotions = context?.emotions || [];

    narrative.chapters.push({
      text: chapter,
      timestamp: now(),
      emotions: chapterEmotions,
    });

    // Merge new characters and emotions
    if (context?.characters) {
      for (const c of context.characters) {
        if (!narrative.characters.includes(c)) narrative.characters.push(c);
      }
    }
    for (const e of chapterEmotions) {
      if (!narrative.emotions.includes(e)) narrative.emotions.push(e);
    }
    if (context?.tags) {
      for (const t of context.tags) {
        if (!narrative.tags.includes(t)) narrative.tags.push(t);
      }
    }

    // Update summary with latest context
    narrative.summary = this.buildSummary(narrative);
    saveStore(store);
  }

  /**
   * Get a specific narrative by ID.
   */
  getNarrative(id: string): Narrative | null {
    const store = loadStore();
    return store.narratives.find((n) => n.id === id) || null;
  }

  /**
   * Search narratives by keyword, emotion, character, or tag.
   */
  searchNarratives(query: string): Narrative[] {
    const store = loadStore();
    const lowerQuery = query.toLowerCase();

    const scored: { narrative: Narrative; score: number }[] = [];

    for (const n of store.narratives) {
      let score = 0;

      // Title and summary match
      score += scoreMatch(n.title + " " + n.summary, query) * 3;

      // Chapter content match
      for (const ch of n.chapters) {
        score += scoreMatch(ch.text, query);
      }

      // Character match
      for (const c of n.characters) {
        if (c.toLowerCase().includes(lowerQuery)) score += 5;
      }

      // Emotion match
      for (const e of n.emotions) {
        if (e.toLowerCase().includes(lowerQuery)) score += 3;
      }

      // Tag match
      for (const t of n.tags) {
        if (t.toLowerCase().includes(lowerQuery)) score += 4;
      }

      if (score > 0) {
        scored.push({ narrative: n, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 20).map((s) => s.narrative);
  }

  /**
   * Get all narratives that are still ongoing (no endDate).
   */
  getOngoingStories(): Narrative[] {
    const store = loadStore();
    return store.narratives.filter((n) => n.ongoing);
  }

  /**
   * Summarize the full arc of a story in natural language.
   */
  getStoryArc(narrativeId: string): string {
    const narrative = this.getNarrative(narrativeId);
    if (!narrative) return "Story not found.";

    const parts: string[] = [];
    parts.push(`"${narrative.title}" — started ${narrative.startDate}.`);

    if (narrative.characters.length > 0) {
      parts.push(`Involves: ${narrative.characters.join(", ")}.`);
    }

    for (let i = 0; i < narrative.chapters.length; i++) {
      const ch = narrative.chapters[i];
      const date = new Date(ch.timestamp).toLocaleDateString();
      const emotionStr = ch.emotions.length > 0 ? ` (${ch.emotions.join(", ")})` : "";
      parts.push(`Chapter ${i + 1} (${date})${emotionStr}: ${ch.text}`);
    }

    if (narrative.ongoing) {
      parts.push("This story is still ongoing.");
    } else {
      parts.push(`Concluded ${narrative.endDate || "at some point"}.`);
    }

    return parts.join("\n");
  }

  /**
   * Detect if the current conversation is part of an ongoing narrative
   * or starts a new one. Checks for life events, project milestones,
   * recurring themes.
   */
  autoDetectNarrative(messages: { role: string; content: string }[]): Narrative | null {
    const userMessages = messages
      .filter((m) => m.role === "user")
      .map((m) => m.content);

    if (userMessages.length === 0) return null;

    const combined = userMessages.join(" ");

    // Check if this matches an ongoing story
    const ongoing = this.getOngoingStories();
    let bestMatch: Narrative | null = null;
    let bestScore = 0;

    for (const story of ongoing) {
      let score = 0;
      for (const char of story.characters) {
        if (textContains(combined, char)) score += 3;
      }
      for (const tag of story.tags) {
        if (!tag.startsWith("related:") && textContains(combined, tag)) score += 2;
      }
      // Check title keywords
      score += scoreMatch(combined, story.title) * 2;

      if (score > bestScore && score >= 2) {
        bestScore = score;
        bestMatch = story;
      }
    }

    if (bestMatch) return bestMatch;

    // Check for new life events or project milestones
    for (const keyword of LIFE_EVENT_KEYWORDS) {
      if (textContains(combined, keyword)) {
        // Potential new narrative — return null to let the caller decide
        // whether to create one via createNarrative
        return null;
      }
    }

    for (const keyword of PROJECT_KEYWORDS) {
      if (textContains(combined, keyword)) {
        return null;
      }
    }

    return null;
  }

  // ── Private helpers ─────────────────────────────────────────

  private generateTitle(event: string): string {
    // Take first sentence or first 80 chars
    const firstSentence = event.split(/[.!?]/)[0].trim();
    if (firstSentence.length <= 80) return firstSentence;
    return firstSentence.slice(0, 77) + "...";
  }

  /** Orchestrator signals: a freshly detected story, or a reminder of an ongoing one. */
  signalsFor(sessionMessages: { role: string; content: string }[]): ModuleSignal[] {
    const out: ModuleSignal[] = [];
    const detected = this.autoDetectNarrative(sessionMessages);
    if (detected) {
      out.push({ source: "narrative-memory", signal: `Ongoing story: "${detected.title}" — ${detected.summary}`, priority: 4, category: "narrative", confidence: 1.0 });
    }
    const ongoing = this.getOngoingStories();
    if (ongoing.length > 0 && !detected) {
      out.push({ source: "narrative-memory", signal: `Continuing narrative: "${ongoing[0].title}"`, priority: 3, category: "narrative", confidence: 1.0 });
    }
    return out;
  }

  private buildSummary(narrative: Narrative): string {
    if (narrative.chapters.length <= 1) return narrative.chapters[0]?.text || "";

    const first = narrative.chapters[0].text;
    const latest = narrative.chapters[narrative.chapters.length - 1].text;
    const chapterCount = narrative.chapters.length;

    return `Started: ${this.truncate(first, 120)} | Latest (chapter ${chapterCount}): ${this.truncate(latest, 120)}`;
  }

  private truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen - 3) + "...";
  }
}
