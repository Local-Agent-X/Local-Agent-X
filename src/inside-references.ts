/**
 * Inside References — shared language and callbacks.
 *
 * Tracks unique phrases, jokes, and shorthand that develop naturally
 * between user and agent. Resolves ambiguous phrases to their shared
 * meaning, and suggests natural callbacks to past moments.
 *
 * Persists to ~/.sax/inside-references.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// ── Types ────────────────────────────────────────────────────

export interface Reference {
  phrase: string;
  means: string;
  context: string;
  firstUsed: string;
  lastUsed: string;
  timesUsed: number;
  sessionIds: string[];
}

export interface ReferenceContext {
  phrase: string;
  means: string;
  firstUsed: string;
  timesUsed: number;
  originalContext: string;
}

export interface Callback {
  reference: string;
  originalContext: string;
  suggestion: string;
}

interface PhraseOccurrence {
  phrase: string;
  context: string;
  sessionId: string;
  timestamp: number;
}

interface ReferenceStore {
  references: Reference[];
  pendingPhrases: PhraseOccurrence[];
}

// ── Persistence ─────────────────────────────────────────────

const SAX_DIR = join(homedir(), ".sax");
const STORE_FILE = join(SAX_DIR, "inside-references.json");
const MAX_REFERENCES = 500;
const MAX_PENDING = 2000;
const AUTO_THRESHOLD = 3; // phrases need 3+ uses to auto-register

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

function loadStore(): ReferenceStore {
  if (!existsSync(STORE_FILE)) return { references: [], pendingPhrases: [] };
  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      references: Array.isArray(parsed.references) ? parsed.references : [],
      pendingPhrases: Array.isArray(parsed.pendingPhrases) ? parsed.pendingPhrases : [],
    };
  } catch {
    return { references: [], pendingPhrases: [] };
  }
}

function saveStore(store: ReferenceStore): void {
  ensureDir();
  if (store.references.length > MAX_REFERENCES) {
    // Keep most recently used
    store.references.sort((a, b) => b.lastUsed.localeCompare(a.lastUsed));
    store.references = store.references.slice(0, MAX_REFERENCES);
  }
  if (store.pendingPhrases.length > MAX_PENDING) {
    store.pendingPhrases = store.pendingPhrases.slice(-MAX_PENDING);
  }
  atomicWrite(STORE_FILE, JSON.stringify(store, null, 2));
}

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function normalize(phrase: string): string {
  return phrase.toLowerCase().trim().replace(/[^\w\s]/g, "");
}

// ── InsideReferences ────────────────────────────────────────

export class InsideReferences {
  private static instance: InsideReferences | null = null;

  private constructor() {}

  static getInstance(): InsideReferences {
    if (!InsideReferences.instance) {
      InsideReferences.instance = new InsideReferences();
    }
    return InsideReferences.instance;
  }

  /**
   * Record a phrase usage. If it appears 3+ times with special meaning,
   * auto-register it as a reference. Can also be used for manual registration
   * when the user explicitly defines a phrase's meaning.
   */
  recordReference(phrase: string, context: string, sessionId: string): void {
    const store = loadStore();
    const normalized = normalize(phrase);
    const today = dateStamp();

    // Check if already a registered reference
    const existing = store.references.find((r) => normalize(r.phrase) === normalized);
    if (existing) {
      existing.timesUsed++;
      existing.lastUsed = today;
      if (!existing.sessionIds.includes(sessionId)) {
        existing.sessionIds.push(sessionId);
      }
      saveStore(store);
      return;
    }

    // Track as pending
    store.pendingPhrases.push({
      phrase: normalized,
      context,
      sessionId,
      timestamp: Date.now(),
    });

    // Check if this phrase has reached the auto-detection threshold
    const occurrences = store.pendingPhrases.filter((p) => p.phrase === normalized);
    if (occurrences.length >= AUTO_THRESHOLD) {
      const uniqueSessions = new Set(occurrences.map((o) => o.sessionId));

      // Only auto-register if used across multiple sessions
      if (uniqueSessions.size >= 2) {
        const ref: Reference = {
          phrase: phrase.trim(),
          means: context,
          context: occurrences[0].context,
          firstUsed: new Date(occurrences[0].timestamp).toISOString().slice(0, 10),
          lastUsed: today,
          timesUsed: occurrences.length,
          sessionIds: Array.from(uniqueSessions),
        };
        store.references.push(ref);

        // Clean up pending
        store.pendingPhrases = store.pendingPhrases.filter((p) => p.phrase !== normalized);
      }
    }

    saveStore(store);
  }

  /**
   * Manually register a reference with explicit meaning.
   * "remember, 'the thing' means deploying to prod"
   */
  defineReference(phrase: string, means: string, context: string, sessionId: string): void {
    const store = loadStore();
    const normalized = normalize(phrase);
    const today = dateStamp();

    const existing = store.references.find((r) => normalize(r.phrase) === normalized);
    if (existing) {
      existing.means = means;
      existing.lastUsed = today;
      existing.timesUsed++;
      saveStore(store);
      return;
    }

    store.references.push({
      phrase: phrase.trim(),
      means,
      context,
      firstUsed: today,
      lastUsed: today,
      timesUsed: 1,
      sessionIds: [sessionId],
    });

    saveStore(store);
  }

  /**
   * Resolve an ambiguous phrase to its shared meaning.
   */
  resolveReference(phrase: string): ReferenceContext | null {
    const store = loadStore();
    const normalized = normalize(phrase);

    // Exact match
    let ref = store.references.find((r) => normalize(r.phrase) === normalized);

    // Partial match: check if the phrase contains a known reference
    if (!ref) {
      const words = normalized.split(/\s+/);
      for (const r of store.references) {
        const refNorm = normalize(r.phrase);
        if (normalized.includes(refNorm) || refNorm.includes(normalized)) {
          ref = r;
          break;
        }
      }
    }

    if (!ref) return null;

    return {
      phrase: ref.phrase,
      means: ref.means,
      firstUsed: ref.firstUsed,
      timesUsed: ref.timesUsed,
      originalContext: ref.context,
    };
  }

  /**
   * Get all established inside references.
   */
  getSharedVocabulary(): Reference[] {
    const store = loadStore();
    return store.references.slice().sort((a, b) => b.timesUsed - a.timesUsed);
  }

  /**
   * Detect when a message references a past shared moment.
   */
  detectCallback(message: string): Callback | null {
    const store = loadStore();
    const lowerMessage = message.toLowerCase();

    // Check for "remember" pattern
    const rememberMatch = lowerMessage.match(/remember\s+(?:when\s+|the\s+time\s+|that\s+)?(.+?)(?:\?|$)/);
    if (rememberMatch) {
      const fragment = rememberMatch[1].trim();
      // Search references for a match
      for (const ref of store.references) {
        if (
          ref.context.toLowerCase().includes(fragment) ||
          ref.phrase.toLowerCase().includes(fragment) ||
          ref.means.toLowerCase().includes(fragment)
        ) {
          return {
            reference: ref.phrase,
            originalContext: ref.context,
            suggestion: `Yeah, "${ref.phrase}" — ${ref.means}. That was from ${ref.firstUsed}.`,
          };
        }
      }
    }

    // Check if message contains a known reference phrase
    for (const ref of store.references) {
      if (lowerMessage.includes(normalize(ref.phrase)) && ref.timesUsed >= 2) {
        return {
          reference: ref.phrase,
          originalContext: ref.context,
          suggestion: `Our thing: "${ref.phrase}" = ${ref.means}`,
        };
      }
    }

    return null;
  }

  /**
   * When talking about a topic, suggest a natural callback to shared history.
   */
  suggestCallback(currentTopic: string): string | null {
    const store = loadStore();
    const lowerTopic = currentTopic.toLowerCase();

    // Find references related to the current topic
    const candidates: { ref: Reference; relevance: number }[] = [];

    for (const ref of store.references) {
      let relevance = 0;
      const refText = `${ref.phrase} ${ref.means} ${ref.context}`.toLowerCase();
      const topicWords = lowerTopic.split(/\s+/).filter((w) => w.length > 3);

      for (const word of topicWords) {
        if (refText.includes(word)) relevance++;
      }

      if (relevance > 0 && ref.timesUsed >= 2) {
        candidates.push({ ref, relevance });
      }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.relevance - a.relevance);
    const best = candidates[0].ref;

    return `Remember "${best.phrase}"? ${best.means} — first came up on ${best.firstUsed}.`;
  }
}
