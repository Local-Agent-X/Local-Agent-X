/**
 * Narrative Memory — persistence + pure scoring helpers.
 *
 * Data shapes, on-disk store I/O, and the stateless keyword/scoring helpers
 * that NarrativeMemory composes. Kept separate from the class so the store
 * layer stays free of singleton/instance concerns.
 *
 * Persists to ~/.lax/narratives.json.
 */

import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { getLaxDir } from "../lax-data-dir.js";
import { createJsonStore } from "../util/json-store.js";

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

export interface NarrativeStore {
  narratives: Narrative[];
}

// ── Persistence ─────────────────────────────────────────────

const LAX_DIR = getLaxDir();
const STORE_FILE = join(LAX_DIR, "narratives.json");
const MAX_NARRATIVES = 2000;

const narrativeStore = createJsonStore<{ narratives: Narrative[] }>(STORE_FILE, {
  defaults: () => ({ narratives: [] }),
  caps: { narratives: MAX_NARRATIVES },
});

export function loadStore(): NarrativeStore {
  return narrativeStore.load();
}

export function saveStore(store: NarrativeStore): void {
  narrativeStore.save(store);
}

export function generateId(): string {
  return randomBytes(8).toString("hex");
}

export function now(): number {
  return Date.now();
}

export function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Keyword helpers ─────────────────────────────────────────

export const LIFE_EVENT_KEYWORDS = [
  "moved", "moving", "new job", "quit", "fired", "hired", "promoted",
  "married", "engaged", "broke up", "divorced", "pregnant", "baby",
  "graduated", "started school", "retired", "lost", "died", "passed away",
  "bought a house", "sold", "launched", "shipped", "released",
  "trip", "vacation", "traveling", "flew to", "driving to",
];

export const PROJECT_KEYWORDS = [
  "building", "working on", "developing", "creating", "launching",
  "deployed", "shipped", "released", "finished", "completed", "started",
];

// Surface markers that the user is telling a story — the cheap pre-gate before
// autoDetectNarrative() does the real life-event / project matching.
export const STORY_PATTERNS = [
  /\bso (basically|what happened|the thing is|long story)\b/i,
  /\byesterday|last (week|month|night|year)\b/i,
  /\bremember when\b/i,
  /\bback when\b/i,
  /\bthe other day\b/i,
];

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
}

export function textContains(text: string, phrase: string): boolean {
  return text.toLowerCase().includes(phrase.toLowerCase());
}

export function scoreMatch(text: string, query: string): number {
  const tokens = tokenize(query);
  if (tokens.length === 0) return 0;
  const lowerText = text.toLowerCase();
  let hits = 0;
  for (const tok of tokens) {
    if (lowerText.includes(tok)) hits++;
  }
  return hits / tokens.length;
}
